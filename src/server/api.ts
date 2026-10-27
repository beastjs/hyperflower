// Backend-for-frontend: triggers generation tasks and relays run updates as SSE,
// so the browser never holds a Trigger.dev or Higgsfield secret.
// Mounted into the Vite dev/preview server by vite.config.ts.

import type { IncomingMessage, ServerResponse } from 'node:http'
import { runs, tasks } from '@trigger.dev/sdk'
import { CloudflareAIError, cloudflareModels, generateCloudflareImage, type CloudflareRequest } from '../lib/cloudflare'
import { imageModels, videoModels, type ImageRequest, type VideoRequest } from '../lib/hf'
import type { GenerationStage, imageTask, videoTask } from '../trigger/generate'

export type GenerateRequest =
  | ({ kind: 'image' } & (ImageRequest | CloudflareRequest))
  | ({ kind: 'video' } & VideoRequest)

export type RunEvent = {
  status: string
  stage?: GenerationStage
  done: boolean
  error?: string
  images?: string[]
  video?: string
}

type Next = (error?: unknown) => void

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const readJson = async (req: IncomingMessage): Promise<unknown> => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return JSON.parse(raw)
}

const parseRequest = (body: unknown): GenerateRequest | string => {
  if (typeof body !== 'object' || body === null) return 'Expected a JSON object'
  const { kind, model, input } = body as Record<string, unknown>
  const models = kind === 'image' ? { ...imageModels, ...cloudflareModels } : kind === 'video' ? videoModels : undefined
  if (!models) return 'kind must be "image" or "video"'
  if (typeof model !== 'string' || !(model in models)) return `Unknown ${kind} model`
  if (typeof input !== 'object' || input === null) return 'input must be an object'
  return { kind, model, input } as GenerateRequest
}

// Workers AI answers in a few seconds with the image bytes, so it is called inline:
// a background run would add latency, and its output is too large for task storage.
async function generateInline(payload: CloudflareRequest, res: ServerResponse) {
  try {
    json(res, 200, { images: [await generateCloudflareImage(payload.model, payload.input)] })
  } catch (error) {
    const status = error instanceof CloudflareAIError && error.httpStatus ? error.httpStatus : 502
    json(res, status >= 500 ? 502 : status, { error: (error as Error).message })
  }
}

async function generate(req: IncomingMessage, res: ServerResponse) {
  const parsed = parseRequest(await readJson(req).catch(() => undefined))
  if (typeof parsed === 'string') return json(res, 400, { error: parsed })

  const { kind, ...payload } = parsed
  if (kind === 'image' && payload.model in cloudflareModels) {
    return generateInline(payload as CloudflareRequest, res)
  }

  if (!process.env.TRIGGER_SECRET_KEY) {
    return json(res, 500, {
      error:
        'TRIGGER_SECRET_KEY is not set. Add it to .env (self-hosted: also TRIGGER_API_URL) and the dev server will reload.'
    })
  }

  const handle =
    kind === 'video'
      ? await tasks.trigger<typeof videoTask>('generate-video', payload as VideoRequest)
      : await tasks.trigger<typeof imageTask>('generate-image', payload as ImageRequest)
  json(res, 202, { runId: handle.id })
}

async function streamRun(runId: string, req: IncomingMessage, res: ServerResponse) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  const controller = new AbortController()
  req.on('close', () => controller.abort())

  try {
    const subscription = runs.subscribeToRun<typeof imageTask | typeof videoTask>(runId, {
      skipColumns: ['payload'],
      signal: controller.signal
    })
    for await (const run of subscription) {
      const output = run.output as { images?: string[]; video?: string } | undefined
      const event: RunEvent = {
        status: run.status,
        stage: run.metadata?.stage as GenerationStage | undefined,
        done: run.isCompleted,
        error: run.isCompleted && !run.isSuccess ? (run.error?.message ?? `Run ${run.status.toLowerCase()}`) : undefined,
        images: output?.images,
        video: output?.video
      }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  } catch (error) {
    if (!controller.signal.aborted) {
      const event: RunEvent = { status: 'ERROR', done: true, error: (error as Error).message }
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    }
  }
  res.end()
}

export async function apiMiddleware(req: IncomingMessage, res: ServerResponse, next: Next) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  try {
    if (req.method === 'POST' && url.pathname === '/api/generate') return await generate(req, res)
    const match = url.pathname.match(/^\/api\/runs\/([\w-]+)\/events$/)
    if (req.method === 'GET' && match) return await streamRun(match[1], req, res)
  } catch (error) {
    if (!res.headersSent) return json(res, 500, { error: (error as Error).message })
    return res.end()
  }
  next()
}
