import { Effect, Schema } from 'effect'
import { HiggsfieldError, run, submit, type RunOptions, type SubmitOptions } from './client'

// https://docs.higgsfield.ai/docs/models/image-generation

export const ImageAspectRatio = Schema.Literals(['9:16', '16:9', '4:3', '3:4', '1:1', '2:3', '3:2'])
export type ImageAspectRatio = typeof ImageAspectRatio.Type

const unit = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }))

const soulBaseFields = {
  prompt: Schema.String,
  aspect_ratio: Schema.optionalKey(ImageAspectRatio),
  resolution: Schema.optionalKey(Schema.Literals(['720p', '1080p'])),
  enhance_prompt: Schema.optionalKey(Schema.Boolean),
  /** 1–1_000_000; random when omitted. */
  seed: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }))),
  batch_size: Schema.optionalKey(Schema.Literals([1, 4])),
  /** UUID of a completed Soul ID character owned by the account. */
  custom_reference_id: Schema.optionalKey(Schema.String),
  custom_reference_strength: Schema.optionalKey(unit)
}

export const SoulInput = Schema.Struct({
  ...soulBaseFields,
  style_id: Schema.optionalKey(Schema.String),
  style_strength: Schema.optionalKey(unit),
  image_reference_url: Schema.optionalKey(Schema.String)
})
export type SoulInput = typeof SoulInput.Type

export const SoulV2Input = Schema.Struct({
  ...soulBaseFields,
  /** List options via GET /v1/text2image/soul-styles/v2 */
  style_id: Schema.optionalKey(Schema.String)
})
export type SoulV2Input = typeof SoulV2Input.Type

/** Cinema uses a fixed style; style_id is ignored. */
export const SoulCinemaInput = Schema.Struct(soulBaseFields)
export type SoulCinemaInput = typeof SoulCinemaInput.Type

export const imageModels = {
  soul: 'higgsfield-ai/soul/standard',
  soulv2: 'higgsfield-ai/soul/v2/standard',
  soulcinema: 'higgsfield-ai/soul/cinema'
} as const

export type ImageInputMap = {
  soul: SoulInput
  soulv2: SoulV2Input
  soulcinema: SoulCinemaInput
}

export type ImageModel = keyof ImageInputMap

/** A model paired with its matching input, e.g. for task payloads. */
export const ImageRequest = Schema.Union([
  Schema.Struct({ model: Schema.Literal('soul'), input: SoulInput }),
  Schema.Struct({ model: Schema.Literal('soulv2'), input: SoulV2Input }),
  Schema.Struct({ model: Schema.Literal('soulcinema'), input: SoulCinemaInput })
])
export type ImageRequest = typeof ImageRequest.Type

export type ImageResult = { requestId: string; images: string[] }

/** Generate images and wait for the result. */
export const generateImage = <M extends ImageModel>(model: M, input: ImageInputMap[M], options?: RunOptions) =>
  Effect.gen(function* () {
    const result = yield* run(imageModels[model], input, options)
    const images = result.images?.map((image) => image.url) ?? []
    if (!images.length) {
      return yield* new HiggsfieldError({ message: `Request ${result.request_id} completed without images`, result })
    }
    return { requestId: result.request_id, images } satisfies ImageResult
  })

/** Queue an image generation without waiting (pair with a webhook or waitFor). */
export const queueImage = <M extends ImageModel>(model: M, input: ImageInputMap[M], options?: SubmitOptions) =>
  submit(imageModels[model], input, options)
