// Backend-for-frontend: triggers generation tasks and relays run updates as SSE,
// so the browser never holds a Trigger.dev or Higgsfield secret.
// Mounted into the Vite dev/preview server by vite.config.ts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { runs, tasks } from '@trigger.dev/sdk'
import { Cause, Config, Effect, Layer, ManagedRuntime, Schema, Stream, Tuple } from 'effect'
import {
  ArkError,
  ArkAgentMessageSchema,
  ArkRequest,
  ArkVideoRequest,
  Ark3DRequest,
  ark3dModels,
  arkModels,
  arkVideoModels,
  generateArkImage,
  generateArkChat,
  generateArkVideo,
  generateArk3D
} from '../lib/ark'
import { CloudflareAIError, CloudflareRequest, cloudflareModels, generateCloudflareImage } from '../lib/cloudflare'
import { HiggsfieldError, ImageRequest, VideoRequest, imageModels, videoModels } from '../lib/hf'
import { BaseLayer } from '../lib/runtime'
import type { GenerationStage, imageTask, videoTask } from '../trigger/generate'
import { NeuronLedger } from './neurons'

export type { NeuronUsage } from './neurons'

const withKind = <K extends string>(kind: K) => Tuple.map(Schema.fieldsAssign({ kind: Schema.Literal(kind) }))

/** The POST /api/generate body: a model, its input, and whether it makes an image or a video. */
export const GenerateRequest = Schema.Union([
  Schema.Union([...ImageRequest.members, ...CloudflareRequest.members, ...ArkRequest.members]).mapMembers(withKind('image')),
  Schema.Union([...VideoRequest.members, ArkVideoRequest]).mapMembers(withKind('video')),
  Schema.Union([Ark3DRequest]).mapMembers(withKind('3d'))
])
export type GenerateRequest = typeof GenerateRequest.Type

export type RunEvent = {
  status: string
  stage?: GenerationStage
  done: boolean
  error?: string
  images?: string[]
  video?: string
}

class BadRequest extends Schema.TaggedError<BadRequest>()('BadRequest', { message: Schema.String }) {}

class TriggerError extends Schema.TaggedError<TriggerError>()('TriggerError', {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

class FileError extends Schema.TaggedError<FileError>()('FileError', {
  message: Schema.String,
  httpStatus: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect())
}) {}

type Reply = { status: number; body: unknown }

const AppLayer = NeuronLedger.layer().pipe(Layer.provideMerge(BaseLayer))
const runtime = ManagedRuntime.make(AppLayer)

const modelNames = (...models: object[]) => models.flatMap(Object.keys)

// Checked before the full request so a wrong kind or model gets a short message,
// rather than one listing every member of GenerateRequest.
const Envelope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('image'),
    model: Schema.Literals(modelNames(imageModels, cloudflareModels, arkModels)).annotate({ message: 'Unknown image model' })
  }),
  Schema.Struct({
    kind: Schema.Literal('video'),
    model: Schema.Literals(modelNames(videoModels, arkVideoModels)).annotate({ message: 'Unknown video model' })
  }),
  Schema.Struct({
    kind: Schema.Literal('3d'),
    model: Schema.Literals(modelNames(ark3dModels)).annotate({ message: 'Unknown 3D model' })
  })
]).annotate({ message: 'kind must be "image", "video" or "3d"' })

const decodeGenerateRequest = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))(body).pipe(
    Effect.tap(Schema.decodeUnknownEffect(Envelope)),
    Effect.flatMap(Schema.decodeUnknownEffect(GenerateRequest)),
    Effect.mapError((error) => new BadRequest({ message: error.message }))
  )

const AgentRequest = Schema.Struct({ messages: Schema.Array(ArkAgentMessageSchema) })
const decodeAgentRequest = (body: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(AgentRequest))(body).pipe(
    Effect.mapError((error) => new BadRequest({ message: error.message }))
  )

const agent = Effect.fn('api.agent')(function* (req: IncomingMessage) {
  const body = yield* readBody(req)
  const { messages } = yield* decodeAgentRequest(body)
  if (!messages.length) return yield* new BadRequest({ message: 'Send a message to start the conversation.' })
  if (messages.length > 40) return yield* new BadRequest({ message: 'This conversation is too long. Start a new one.' })
  if (messages.some((message) => message.content.length > 12_000)) {
    return yield* new BadRequest({ message: 'Each message must be 12,000 characters or fewer.' })
  }
  return { status: 200, body: { message: yield* generateArkChat(messages) } } satisfies Reply
})

const readBody = (req: IncomingMessage) =>
  Effect.tryPromise({
    try: async () => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      return raw
    },
    catch: () => new BadRequest({ message: 'Could not read the request body' })
  })

// Provider errors keep their 4xx status; anything upstream that broke is a 502.
const errorReply = (error: BadRequest | TriggerError | FileError | ArkError | CloudflareAIError | HiggsfieldError): Reply => {
  switch (error._tag) {
    case 'BadRequest':
      return { status: 400, body: { error: error.message } }
    case 'TriggerError':
      return { status: 500, body: { error: error.message } }
    default: {
      const status = error.httpStatus && error.httpStatus < 500 ? error.httpStatus : 502
      return { status, body: { error: error.message } }
    }
  }
}

const triggerTask = (request: ImageRequest | VideoRequest, kind: 'image' | 'video') =>
  Effect.gen(function* () {
    yield* Config.Redacted('TRIGGER_SECRET_KEY').pipe(
      Effect.mapError(
        () =>
          new TriggerError({
            message:
              'TRIGGER_SECRET_KEY is not set. Add it to .env (self-hosted: also TRIGGER_API_URL) and the dev server will reload.'
          })
      )
    )
    const trigger = (): Promise<{ id: string }> =>
      kind === 'video'
        ? tasks.trigger<typeof videoTask>('generate-video', request as VideoRequest)
        : tasks.trigger<typeof imageTask>('generate-image', request as ImageRequest)
    const handle = yield* Effect.tryPromise({
      try: trigger,
      catch: (cause) =>
        new TriggerError({ message: cause instanceof Error ? cause.message : `Could not start the ${kind} run`, cause })
    })
    return { status: 202, body: { runId: handle.id } } satisfies Reply
  })

// Workers AI and Ark are called inline: a background run would add latency, and Workers AI's
// image bytes are too large for task storage. Ark video holds the request open while it polls.
const generate = Effect.fn('api.generate')(function* (req: IncomingMessage) {
  const body = yield* readBody(req)
  const { kind, ...request } = yield* decodeGenerateRequest(body)

  if (Schema.is(CloudflareRequest)(request)) {
    const { image, neurons } = yield* generateCloudflareImage(request)
    const ledger = yield* NeuronLedger
    // The image is already paid for, so a ledger write failure must not lose it.
    yield* ledger.record(neurons).pipe(Effect.catchTag('LedgerError', (error) => Effect.logWarning(error.message, error.cause)))
    return { status: 200, body: { images: [image], neurons } } satisfies Reply
  }
  if (Schema.is(ArkRequest)(request)) {
    return { status: 200, body: { images: [yield* generateArkImage(request)] } } satisfies Reply
  }
  if (Schema.is(ArkVideoRequest)(request)) {
    return { status: 200, body: { video: yield* generateArkVideo(request) } } satisfies Reply
  }
  // Inline like Ark video: the request stays open for the ~12 minutes a textured model takes.
  if (Schema.is(Ark3DRequest)(request)) {
    return { status: 200, body: { model3d: yield* generateArk3D(request) } } satisfies Reply
  }
  return yield* triggerTask(request, kind === 'video' ? 'video' : 'image')
})

const usage = Effect.gen(function* () {
  const ledger = yield* NeuronLedger
  return { status: 200, body: yield* ledger.usage } satisfies Reply
})

// Generated 3D models live on Ark's object storage, which sends no CORS headers, so the browser
// fetches them through here. Only those hosts are relayed: this must not become an open proxy.
const fileHosts = ['.volces.com', '.bytepluses.com', '.byteplus.com']

const isFileUrl = (url: URL) => url.protocol === 'https:' && fileHosts.some((host) => url.hostname.endsWith(host))

const proxyFile = (url: string | null, res: ServerResponse) =>
  Effect.gen(function* () {
    const target = URL.canParse(url ?? '') ? new URL(url ?? '') : undefined
    if (!target || !isFileUrl(target)) return yield* new BadRequest({ message: 'url must be a generated file URL' })

    const upstream = yield* Effect.tryPromise({
      try: (signal) => fetch(target, { signal }),
      catch: (cause) => new FileError({ message: 'Could not reach the file host', cause })
    })
    if (!upstream.ok || !upstream.body) {
      // Ark's links are presigned and expire; the host answers 403 once they do.
      const expired = upstream.status === 403 || upstream.status === 404
      return yield* new FileError({
        message: expired ? 'This file has expired' : `File host answered ${upstream.status}`,
        httpStatus: expired ? 410 : upstream.status
      })
    }
    // DOM and Node type the same web stream differently.
    const body = upstream.body as unknown as NodeReadableStream
    const length = upstream.headers.get('content-length')
    yield* Effect.sync(() =>
      res.writeHead(200, {
        'Content-Type': upstream.headers.get('content-type') ?? 'application/octet-stream',
        'Cache-Control': 'private, max-age=86400',
        ...(length && { 'Content-Length': length })
      })
    )
    yield* Effect.tryPromise({
      try: (signal) => pipeline(Readable.fromWeb(body), res, { signal }),
      catch: (cause) => new FileError({ message: 'File transfer was cut short', cause })
    })
  }).pipe(
    // Once the body has started, the status is sent; all that is left is to end the response.
    Effect.catch((error) => (res.headersSent ? Effect.sync(() => res.destroy()) : json(res, errorReply(error)))),
    Effect.withSpan('api.proxyFile')
  )

const toRunEvent = (run: {
  status: string
  isCompleted: boolean
  isSuccess: boolean
  error?: { message?: string }
  output?: unknown
  metadata?: Record<string, unknown>
}): RunEvent => {
  const output = run.output as { images?: string[]; video?: string } | undefined
  return {
    status: run.status,
    stage: run.metadata?.stage as GenerationStage | undefined,
    done: run.isCompleted,
    error: run.isCompleted && !run.isSuccess ? (run.error?.message ?? `Run ${run.status.toLowerCase()}`) : undefined,
    images: output?.images,
    video: output?.video
  }
}

// Interrupting the fiber (the browser disconnected) ends the subscription without an error event.
const streamRun = (runId: string, res: ServerResponse) => {
  const send = (event: RunEvent) => Effect.sync(() => res.write(`data: ${JSON.stringify(event)}\n\n`))
  return Effect.sync(() =>
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  ).pipe(
    Effect.andThen(
      Stream.fromAsyncIterable(
        runs.subscribeToRun<typeof imageTask | typeof videoTask>(runId, { skipColumns: ['payload'] }),
        (cause) => new TriggerError({ message: cause instanceof Error ? cause.message : String(cause), cause })
      ).pipe(Stream.runForEach((run) => send(toRunEvent(run))))
    ),
    Effect.catchTag('TriggerError', (error) => send({ status: 'ERROR', done: true, error: error.message })),
    Effect.ensuring(Effect.sync(() => res.end())),
    Effect.withSpan('api.streamRun', { attributes: { runId } })
  )
}

const json = (res: ServerResponse, { status, body }: Reply) =>
  Effect.sync(() => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })

const reply = <R>(res: ServerResponse, handler: Effect.Effect<Reply, Parameters<typeof errorReply>[0], R>) =>
  handler.pipe(
    Effect.catch((error) => Effect.succeed(errorReply(error))),
    Effect.flatMap((result) => json(res, result))
  )

type Next = (error?: unknown) => void

export async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = url.pathname.match(/^\/api\/runs\/([\w-]+)\/events$/)
  const route =
    req.method === 'POST' && url.pathname === '/api/generate'
      ? reply(res, generate(req))
      : req.method === 'POST' && url.pathname === '/api/agent'
        ? reply(res, agent(req))
      : req.method === 'GET' && url.pathname === '/api/usage/neurons'
        ? reply(res, usage)
        : req.method === 'GET' && url.pathname === '/api/files'
          ? proxyFile(url.searchParams.get('url'), res)
          : req.method === 'GET' && match
            ? streamRun(match[1], res)
            : undefined
  if (!route) return next()

  // 'close' before the reply is sent means the browser went away; stop the work it asked for.
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  await runtime.runPromise(
    route.pipe(
      // Defects (bugs, unexpected throws) still answer the request.
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) return
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' })
            const error = Cause.squash(cause)
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Internal error' }))
          } else res.end()
        })
      )
    ),
    { signal: controller.signal }
  ).catch(() => {})
}
