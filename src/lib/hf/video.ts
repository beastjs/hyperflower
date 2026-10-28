import { Effect, Schema } from 'effect'
import { HiggsfieldError, run, submit, type RunOptions, type SubmitOptions } from './client'

// https://docs.higgsfield.ai/docs/models/video-generation

export const VideoResolution = Schema.Literals(['480p', '720p', '1080p'])
export type VideoResolution = typeof VideoResolution.Type
export const VideoAspectRatio = Schema.Literals(['16:9', '4:3', '1:1', '3:4', '9:16'])
export type VideoAspectRatio = typeof VideoAspectRatio.Type

const seconds = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))
const urls = (max: number) => Schema.Array(Schema.String).check(Schema.isMaxLength(max))

const seedanceBaseFields = {
  prompt: Schema.optionalKey(Schema.String),
  /** 4–30 seconds, default 5. */
  duration: Schema.optionalKey(seconds(4, 30)),
  resolution: Schema.optionalKey(VideoResolution),
  bitrate_mode: Schema.optionalKey(Schema.Literals(['standard', 'high'])),
  generate_audio: Schema.optionalKey(Schema.Boolean)
}

const wideAspectRatio = Schema.Literals([...VideoAspectRatio.literals, '21:9'])

export const SeedanceTextInput = Schema.Struct({
  ...seedanceBaseFields,
  prompt: Schema.String,
  aspect_ratio: Schema.optionalKey(wideAspectRatio),
  output_format: Schema.optionalKey(Schema.Literals(['mp4', 'mov']))
})
export type SeedanceTextInput = typeof SeedanceTextInput.Type

export const SeedanceImageInput = Schema.Struct({
  ...seedanceBaseFields,
  /** First frame. */
  image_url: Schema.String,
  /** Optional last frame. */
  end_image_url: Schema.optionalKey(Schema.String)
})
export type SeedanceImageInput = typeof SeedanceImageInput.Type

const MISSING_REFERENCES = 'seedanceReference needs at least one of image_urls, video_urls, or audio_urls'

/** At least one of image_urls, video_urls, or audio_urls is required (50 references max). */
export const SeedanceReferenceInput = Schema.Struct({
  ...seedanceBaseFields,
  aspect_ratio: Schema.optionalKey(wideAspectRatio),
  image_urls: Schema.optionalKey(Schema.Array(Schema.String)),
  video_urls: Schema.optionalKey(Schema.Array(Schema.String)),
  audio_urls: Schema.optionalKey(Schema.Array(Schema.String))
}).check(
  Schema.makeFilter(({ image_urls = [], video_urls = [], audio_urls = [] }) => {
    const count = image_urls.length + video_urls.length + audio_urls.length
    return count === 0 ? MISSING_REFERENCES : count <= 50 || 'seedanceReference takes at most 50 references'
  })
)
export type SeedanceReferenceInput = typeof SeedanceReferenceInput.Type

export const WanReferenceInput = Schema.Struct({
  prompt: Schema.String,
  seed: Schema.optionalKey(Schema.Int),
  /** 2–30 seconds, default 5. */
  duration: Schema.optionalKey(seconds(2, 30)),
  resolution: Schema.optionalKey(VideoResolution),
  aspect_ratio: Schema.optionalKey(Schema.Literals([...VideoAspectRatio.literals, 'adaptive'])),
  image_urls: Schema.optionalKey(urls(10)),
  /** Up to 5 clips, 30s total. */
  video_urls: Schema.optionalKey(urls(5)),
  /** Up to 5 WAV/MP3 files, 30s total. */
  audio_urls: Schema.optionalKey(urls(5)),
  /** docx/xlsx/pptx/pdf/md; enables thinking. Takes precedence over link_url. */
  file_url: Schema.optionalKey(Schema.String),
  /** Public web page; enables thinking. */
  link_url: Schema.optionalKey(Schema.String),
  generate_audio: Schema.optionalKey(Schema.Boolean),
  enable_thinking: Schema.optionalKey(Schema.Boolean)
})
export type WanReferenceInput = typeof WanReferenceInput.Type

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
export const VideoRequest = Schema.Union([
  Schema.Struct({ model: Schema.Literal('seedanceText'), input: SeedanceTextInput }),
  Schema.Struct({ model: Schema.Literal('seedanceImage'), input: SeedanceImageInput }),
  Schema.Struct({ model: Schema.Literal('seedanceReference'), input: SeedanceReferenceInput }),
  Schema.Struct({ model: Schema.Literal('wanReference'), input: WanReferenceInput })
])
export type VideoRequest = typeof VideoRequest.Type

export type VideoResult = { requestId: string; video: string }

// Videos routinely take several minutes; poll longer and less often than images.
const VIDEO_WAIT_DEFAULTS: RunOptions = { pollInterval: 5000, maxPollInterval: 30_000, timeout: 20 * 60_000 }

// Request bodies are decoded at the API boundary; this guards direct callers, which TypeScript
// cannot stop from sending a reference request without references.
const checkInput = <M extends VideoModel>(model: M, input: VideoInputMap[M]) =>
  model === 'seedanceReference' && !Schema.is(SeedanceReferenceInput)(input)
    ? Effect.fail(new HiggsfieldError({ message: MISSING_REFERENCES }))
    : Effect.void

/** Generate a video and wait for the result. */
export const generateVideo = <M extends VideoModel>(model: M, input: VideoInputMap[M], options?: RunOptions) =>
  Effect.gen(function* () {
    yield* checkInput(model, input)
    const result = yield* run(videoModels[model], input, { ...VIDEO_WAIT_DEFAULTS, ...options })
    if (!result.video?.url) {
      return yield* new HiggsfieldError({ message: `Request ${result.request_id} completed without a video`, result })
    }
    return { requestId: result.request_id, video: result.video.url } satisfies VideoResult
  })

/** Queue a video generation without waiting (pair with a webhook or waitFor). */
export const queueVideo = <M extends VideoModel>(model: M, input: VideoInputMap[M], options?: SubmitOptions) =>
  checkInput(model, input).pipe(Effect.andThen(submit(videoModels[model], input, options)))
