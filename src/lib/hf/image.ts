import { run, submit, HiggsfieldError, type RunOptions, type SubmitOptions } from './client'

// https://docs.higgsfield.ai/docs/models/image-generation

export type ImageAspectRatio = '9:16' | '16:9' | '4:3' | '3:4' | '1:1' | '2:3' | '3:2'

type SoulBaseInput = {
  prompt: string
  aspect_ratio?: ImageAspectRatio
  resolution?: '720p' | '1080p'
  enhance_prompt?: boolean
  /** 1–1_000_000; random when omitted. */
  seed?: number
  batch_size?: 1 | 4
  /** UUID of a completed Soul ID character owned by the account. */
  custom_reference_id?: string
  /** 0–1 */
  custom_reference_strength?: number
}

export type SoulInput = SoulBaseInput & {
  style_id?: string
  /** 0–1 */
  style_strength?: number
  image_reference_url?: string
}

export type SoulV2Input = SoulBaseInput & {
  /** List options via GET /v1/text2image/soul-styles/v2 */
  style_id?: string
}

/** Cinema uses a fixed style; style_id is ignored. */
export type SoulCinemaInput = SoulBaseInput

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
export type ImageRequest = { [M in ImageModel]: { model: M; input: ImageInputMap[M] } }[ImageModel]

export type ImageResult = { requestId: string; images: string[] }

/** Generate images and wait for the result. */
export const generateImage = async <M extends ImageModel>(
  model: M,
  input: ImageInputMap[M],
  options?: RunOptions
): Promise<ImageResult> => {
  const result = await run(imageModels[model], input, options)
  const images = result.images?.map((image) => image.url) ?? []
  if (!images.length) throw new HiggsfieldError(`Request ${result.request_id} completed without images`, undefined, undefined, result)
  return { requestId: result.request_id, images }
}

/** Queue an image generation without waiting (pair with a webhook or waitFor). */
export const queueImage = <M extends ImageModel>(model: M, input: ImageInputMap[M], options?: SubmitOptions) =>
  submit(imageModels[model], input, options)
