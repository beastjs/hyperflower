import { run, submit, HiggsfieldError, type RunOptions, type SubmitOptions } from './client'

// https://docs.higgsfield.ai/docs/models/video-generation

export type VideoResolution = '480p' | '720p' | '1080p'
export type VideoAspectRatio = '16:9' | '4:3' | '1:1' | '3:4' | '9:16'

type SeedanceBaseInput = {
  prompt?: string
  /** 4–30 seconds, default 5. */
  duration?: number
  resolution?: VideoResolution
  bitrate_mode?: 'standard' | 'high'
  generate_audio?: boolean
}

export type SeedanceTextInput = SeedanceBaseInput & {
  prompt: string
  aspect_ratio?: VideoAspectRatio | '21:9'
  output_format?: 'mp4' | 'mov'
}

export type SeedanceImageInput = SeedanceBaseInput & {
  /** First frame. */
  image_url: string
  /** Optional last frame. */
  end_image_url?: string
}

/** At least one of image_urls, video_urls, or audio_urls is required (50 references max). */
export type SeedanceReferenceInput = SeedanceBaseInput & {
  aspect_ratio?: VideoAspectRatio | '21:9'
  image_urls?: string[]
  video_urls?: string[]
  audio_urls?: string[]
}

export type WanReferenceInput = {
  prompt: string
  seed?: number
  /** 2–30 seconds, default 5. */
  duration?: number
  resolution?: VideoResolution
  aspect_ratio?: VideoAspectRatio | 'adaptive'
  /** Up to 10 images. */
  image_urls?: string[]
  /** Up to 5 clips, 30s total. */
  video_urls?: string[]
  /** Up to 5 WAV/MP3 files, 30s total. */
  audio_urls?: string[]
  /** docx/xlsx/pptx/pdf/md; enables thinking. Takes precedence over link_url. */
  file_url?: string
  /** Public web page; enables thinking. */
  link_url?: string
  generate_audio?: boolean
  enable_thinking?: boolean
}

export const videoModels = {
  seedanceText: 'bytedance/seedance-2.5/text-to-video',
  seedanceImage: 'bytedance/seedance-2.5/image-to-video',
  seedanceReference: 'bytedance/seedance-2.5/reference-to-video',
  wanReference: 'alibaba/wan-3.0/reference-to-video'
} as const

export type VideoInputMap = {
  seedanceText: SeedanceTextInput
  seedanceImage: SeedanceImageInput
  seedanceReference: SeedanceReferenceInput
  wanReference: WanReferenceInput
}

export type VideoModel = keyof VideoInputMap

/** A model paired with its matching input, e.g. for task payloads. */
export type VideoRequest = { [M in VideoModel]: { model: M; input: VideoInputMap[M] } }[VideoModel]

export type VideoResult = { requestId: string; video: string }

// Videos routinely take several minutes; poll longer and less often than images.
const VIDEO_WAIT_DEFAULTS: RunOptions = { pollInterval: 5000, maxPollInterval: 30_000, timeout: 20 * 60_000 }

const assertValidInput = <M extends VideoModel>(model: M, input: VideoInputMap[M]) => {
  if (model === 'seedanceReference') {
    const { image_urls, video_urls, audio_urls } = input as SeedanceReferenceInput
    if (!image_urls?.length && !video_urls?.length && !audio_urls?.length) {
      throw new HiggsfieldError('seedanceReference needs at least one of image_urls, video_urls, or audio_urls')
    }
  }
}

/** Generate a video and wait for the result. */
export const generateVideo = async <M extends VideoModel>(
  model: M,
  input: VideoInputMap[M],
  options?: RunOptions
): Promise<VideoResult> => {
  assertValidInput(model, input)
  const result = await run(videoModels[model], input, { ...VIDEO_WAIT_DEFAULTS, ...options })
  if (!result.video?.url) throw new HiggsfieldError(`Request ${result.request_id} completed without a video`, undefined, undefined, result)
  return { requestId: result.request_id, video: result.video.url }
}

/** Queue a video generation without waiting (pair with a webhook or waitFor). */
export const queueVideo = <M extends VideoModel>(model: M, input: VideoInputMap[M], options?: SubmitOptions) => {
  assertValidInput(model, input)
  return submit(videoModels[model], input, options)
}
