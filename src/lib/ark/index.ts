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

const arkRequest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
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

// The task API (Seedance video, Hitem3D) shares one task shape; each model fills its own content field.
const ArkTask = Schema.Struct({
  id: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(Schema.Literals(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'expired'])),
  content: Schema.optionalKey(
    Schema.Struct({
      video_url: Schema.optionalKey(Schema.String),
      // 3D results; given as a bare URL or as { url }.
      file_url: Schema.optionalKey(Schema.Union([Schema.String, Schema.Struct({ url: Schema.String })]))
    })
  ),
  error: Schema.optionalKey(Schema.Struct({ message: Schema.optionalKey(Schema.String) }))
})
type ArkTask = typeof ArkTask.Type

const TASKS = '/contents/generations/tasks'

const taskRequest = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const res = yield* arkRequest(method, path, body)
    const json = decodeBody(ArkTask, res.body)
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

type TaskOptions = { interval?: number; timeout?: number }

/**
 * Create a task and poll it until `result` yields a URL. If the caller is interrupted (the browser
 * went away), the task is cancelled so a long, billed job does not keep running unseen.
 */
const runTask = (
  model: string,
  body: object,
  result: (task: ArkTask) => string | undefined,
  { interval = 3_000, timeout = 10 * 60_000 }: TaskOptions
) =>
  Effect.gen(function* () {
    const { id } = yield* taskRequest('POST', TASKS, body)
    if (!id) return yield* new ArkError({ message: `Ark ${model} returned no task id` })
    const path = `${TASKS}/${encodeURIComponent(id)}`

    const poll = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(interval)
        const task = yield* taskRequest('GET', path)
        const url = task.status === 'succeeded' ? result(task) : undefined
        if (url) return url
        if (task.status && task.status !== 'queued' && task.status !== 'running') {
          const reason = task.error?.message ?? (task.status === 'succeeded' ? 'no result in the response' : undefined)
          return yield* new ArkError({ message: `Ark ${model} task ${task.status}${reason ? `: ${reason}` : ''}`, body: task })
        }
      }
    })
    return yield* poll.pipe(
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(new ArkError({ message: `Ark ${model} task ${id} timed out` }))
      }),
      Effect.onInterrupt(() => taskRequest('DELETE', path).pipe(Effect.ignore))
    )
  })

/** Generate one video, polling the task until it finishes; returns its URL, which Ark keeps for 24 hours. */
export const generateArkVideo = ({ model, input }: ArkVideoRequest, options: TaskOptions = {}) =>
  Effect.gen(function* () {
    const { prompt, image_url, ratio, watermark = false, ...fields } = input
    if (!prompt && !image_url) return yield* new ArkError({ message: 'A prompt or start frame is required' })
    const content = [
      ...(prompt ? [{ type: 'text', text: prompt }] : []),
      ...(image_url ? [{ type: 'image_url', image_url: { url: image_url }, role: 'first_frame' }] : [])
    ]
    const body = { model: arkVideoModels[model], content, ratio: image_url ? 'adaptive' : ratio, watermark, ...fields }
    return yield* runTask(model, body, (task) => task.content?.video_url, options)
  }).pipe(Effect.withSpan('Ark.generateVideo', { attributes: { model } }))

// Hitem3D 2.0: 1-4 photos of one object to a 3D model. Options travel as `--name value` flags in
// a text item. Ref: BytePlus' ComfyUI nodes (byteplus-sa/ComfyUI-BytePlus-ModelArk, nodes/nodes_3d.py).

export const MAX_3D_VIEWS = 4
/** View order for the reference images and the `views` bitmap. */
export const MODEL_3D_VIEWS = ['front', 'back', 'left', 'right'] as const

export const Model3DFormat = Schema.Literals(['glb', 'obj', 'stl', 'fbx', 'usdz'])
export type Model3DFormat = typeof Model3DFormat.Type

const FORMAT_CODES: Record<Model3DFormat, number> = { obj: 1, glb: 2, stl: 3, fbx: 4, usdz: 5 }

export const Hitem3DInput = Schema.Struct({
  /** 1-4 image URLs or base64 data URLs of one object (each under 10 MB and 4096x4096), in view order. */
  images: Schema.Array(Schema.String).check(Schema.isBetweenLength(1, MAX_3D_VIEWS)),
  /** "1536" (default) or the finer "1536pro". */
  resolution: Schema.optionalKey(Schema.Literals(['1536', '1536pro'])),
  /** Textured model (default) or geometry only. */
  texture: Schema.optionalKey(Schema.Boolean),
  /** File format; default glb, the only one that carries textures. */
  format: Schema.optionalKey(Model3DFormat),
  /** Face count, 100,000-2,000,000; the model picks one when omitted. */
  face: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 100_000, maximum: 2_000_000 }))),
  /** Which views the images are, as 4 digits for front, back, left, right (1010 = front and left); default: the first ones. */
  views: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[01]{4}$/)))
}).check(
  Schema.makeFilter(({ images, views }) =>
    views === undefined || views.split('').filter((bit) => bit === '1').length === images.length
      ? undefined
      : { path: ['views'], issue: 'views needs one 1 per image' }
  )
)
export type Hitem3DInput = typeof Hitem3DInput.Type

export const ark3dModels = {
  hitem3d: 'hitem3d-2-0-251223'
} as const

export type Ark3DModel = keyof typeof ark3dModels

export const Ark3DRequest = Schema.Struct({ model: Schema.Literal('hitem3d'), input: Hitem3DInput })
export type Ark3DRequest = typeof Ark3DRequest.Type

export type Model3D = { url: string; format: Model3DFormat }

/**
 * Generate one 3D model; returns its file URL, which Ark keeps for 24 hours. A textured 1536 model
 * takes around 12 minutes, so the default timeout is generous.
 */
export const generateArk3D = ({ model, input }: Ark3DRequest, options: TaskOptions = {}) =>
  Effect.gen(function* () {
    const { images, resolution, texture = true, format = 'glb', face, views } = input
    const flags = {
      resolution,
      request_type: texture ? 3 : 1,
      fileformat: FORMAT_CODES[format],
      face,
      multi_images_bit: views ?? (images.length > 1 ? '1'.repeat(images.length).padEnd(MAX_3D_VIEWS, '0') : undefined)
    }
    const text = Object.entries(flags)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `--${name} ${value}`)
      .join(' ')
    const content = [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))]
    const fileUrl = (task: ArkTask) => {
      const file = task.content?.file_url
      return typeof file === 'string' ? file : file?.url
    }
    const url = yield* runTask(model, { model: ark3dModels[model], content }, fileUrl, {
      interval: 10_000,
      timeout: 25 * 60_000,
      ...options
    })
    return { url, format } satisfies Model3D
  }).pipe(Effect.withSpan('Ark.generate3D', { attributes: { model } }))
