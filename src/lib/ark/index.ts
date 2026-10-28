// BytePlus ModelArk image generation (Seedream).
// Ref: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/image-generation-api
// Server-side only: the API key must never reach the browser bundle.

import { Config, Effect, Option, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { execute } from '../runtime'

export class ArkError extends Schema.TaggedError<ArkError>()('ArkError', {
  message: Schema.String,
  httpStatus: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown)
}) {}

export const MAX_ARK_REFERENCE_IMAGES = 10

export const SeedreamInput = Schema.Struct({
  prompt: Schema.String,
  /** "1K" | "1.5K" | "2K", or "WxH" with 921,600–4,624,220 total pixels; default "2K". */
  size: Schema.optionalKey(Schema.String),
  /** Up to 10 image URLs or base64 data URLs; the prompt can refer to them as "image 1", "image 2", … */
  image: Schema.optionalKey(Schema.Array(Schema.String)),
  output_format: Schema.optionalKey(Schema.Literals(['png', 'jpeg'])),
  /** Adds an "AI generated" mark in the lower-right corner; default true. */
  watermark: Schema.optionalKey(Schema.Boolean)
})
export type SeedreamInput = typeof SeedreamInput.Type

export const arkModels = {
  seedream5Pro: 'dola-seedream-5-0-pro-260628',
  seedream5Flash: 'dola-seedream-5-0-flash-260915'
} as const

export type ArkModel = keyof typeof arkModels

/** A model paired with its matching input, e.g. for task payloads. */
export const ArkRequest = Schema.Union([
  Schema.Struct({ model: Schema.Literal('seedream5Pro'), input: SeedreamInput }),
  Schema.Struct({ model: Schema.Literal('seedream5Flash'), input: SeedreamInput })
])
export type ArkRequest = typeof ArkRequest.Type

const GenerationResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        url: Schema.optionalKey(Schema.String),
        error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
      })
    )
  ),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
})

const credentials = Effect.all({
  apiKey: Config.Redacted('ARK_API_KEY').pipe(
    Effect.mapError(() => new ArkError({ message: 'Missing BytePlus credentials: set ARK_API_KEY' }))
  ),
  baseUrl: Config.String('ARK_BASE_URL').pipe(
    Config.withDefault('https://ark.ap-southeast.bytepluses.com/api/v3'),
    Effect.map((url) => url.replace(/\/+$/, '')),
    Effect.orDie
  )
})

// Lenient: a body that does not match still yields its status-based error message.
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: unknown): S['Type'] | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(body))

const arkRequest = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { apiKey, baseUrl } = yield* credentials
    return yield* HttpClientRequest.make(method)(`${baseUrl}${path}`).pipe(
      HttpClientRequest.bearerToken(apiKey),
      body === undefined ? (req) => req : HttpClientRequest.bodyJsonUnsafe(body),
      execute,
      Effect.mapError((cause) => new ArkError({ message: `Ark ${path} failed: ${cause.message}` }))
    )
  })

/** Generate one image; returns its URL, which Ark keeps for 24 hours. */
export const generateArkImage = Effect.fn('Ark.generateImage')(function* ({ model, input }: ArkRequest) {
  const { image = [], ...fields } = input
  if (image.length > MAX_ARK_REFERENCE_IMAGES) {
    return yield* new ArkError({ message: `At most ${MAX_ARK_REFERENCE_IMAGES} reference images are supported` })
  }
  const res = yield* arkRequest('POST', '/images/generations', {
    model: arkModels[model],
    watermark: false,
    ...fields,
    ...(image.length && { image }),
    response_format: 'url'
  })
  const json = decodeBody(GenerationResponse, res.body)
  const url = json?.data?.[0]?.url
  if (!res.ok || !url) {
    const reason = json?.error?.message ?? json?.data?.[0]?.error?.message
    return yield* new ArkError({
      message: `Ark ${model} failed with ${res.status}${reason ? `: ${reason}` : ''}`,
      httpStatus: res.status,
      body: res.body
    })
  }
  return url
})

export const SeedanceInput = Schema.Struct({
  prompt: Schema.optionalKey(Schema.String),
  /** Start frame, as a URL or base64 data URL; the video then keeps its aspect ratio. */
  image_url: Schema.optionalKey(Schema.String),
  resolution: Schema.optionalKey(Schema.Literals(['480p', '720p', '1080p'])),
  /** Ignored with a start frame, which uses "adaptive". */
  ratio: Schema.optionalKey(Schema.Literals(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9'])),
  /** 2–12 seconds, default 5. */
  duration: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 12 }))),
  /** Adds an "AI generated" mark; default false here. */
  watermark: Schema.optionalKey(Schema.Boolean)
}).check(Schema.makeFilter(({ prompt, image_url }) => Boolean(prompt || image_url) || 'A prompt or start frame is required'))
export type SeedanceInput = typeof SeedanceInput.Type

export const arkVideoModels = {
  seedanceFast: 'seedance-1-0-pro-fast-251015'
} as const

export type ArkVideoModel = keyof typeof arkVideoModels

export const ArkVideoRequest = Schema.Struct({ model: Schema.Literal('seedanceFast'), input: SeedanceInput })
export type ArkVideoRequest = typeof ArkVideoRequest.Type

const VideoTask = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])),
  content: Schema.optionalKey(Schema.Struct({ video_url: Schema.optionalKey(Schema.String) })),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
})

const taskRequest = (method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const res = yield* arkRequest(method, path, body)
    const json = decodeBody(VideoTask, res.body)
    if (!res.ok) {
      const reason = json?.error?.message
      return yield* new ArkError({
        message: `Ark ${path} failed with ${res.status}${reason ? `: ${reason}` : ''}`,
        httpStatus: res.status,
        body: res.body
      })
    }
    return json ?? {}
  })

/** Generate one video, polling the task until it finishes; returns its URL, which Ark keeps for 24 hours. */
export const generateArkVideo = (
  { model, input }: ArkVideoRequest,
  { interval = 3_000, timeout = 10 * 60_000 } = {}
) =>
  Effect.gen(function* () {
    const { prompt, image_url, ratio, watermark = false, ...fields } = input
    if (!prompt && !image_url) return yield* new ArkError({ message: 'A prompt or start frame is required' })
    const content = [
      ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ...(image_url ? [{ type: 'image_url', image_url: { url: image_url }, role: 'first_frame' }] : [])
    ]
    const { id } = yield* taskRequest('POST', '/contents/generations/tasks', {
      model: arkVideoModels[model],
      content,
      ratio: image_url ? 'adaptive' : ratio,
      watermark,
      ...fields
    })
    if (!id) return yield* new ArkError({ message: `Ark ${model} returned no task id` })

    const poll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(interval)
        const task = yield* taskRequest('GET', `/contents/generations/tasks/${encodeURIComponent(id)}`)
        if (task.status === 'succeeded' && task.content?.video_url) return task.content.video_url
        if (task.status && task.status !== 'queued' && task.status !== 'running') {
          const reason = task.error?.message
          return yield* new ArkError({ message: `Ark ${model} task ${task.status}${reason ? `: ${reason}` : ''}`, body: task })
        }
      }
    })
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ArkError({ message: `Ark ${model} task ${id} timed out` }))
      })
    )
  }).pipe(Effect.withSpan('Ark.generateVideo', { attributes: { model } }))
