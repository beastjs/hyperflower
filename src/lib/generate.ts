// Browser-side helpers for the generation UI. Type-only imports keep hf/server code out of the bundle.
import type { GenerateRequest, NeuronUsage, RunEvent } from '@/server/api'
import type { Ark3DModel, ArkModel, ArkVideoModel, Model3D, Model3DFormat } from './ark'
import type { CloudflareModel } from './cloudflare'
import { estimateNeurons } from './cloudflare/pricing'
import type { ImageModel as HiggsfieldImageModel, VideoModel as HiggsfieldVideoModel } from './hf'

export type Mode = 'image' | 'video' | '3d'
export type Resolution = '720p' | '1080p'
export type Duration = 5 | 10
export type ImageModel = HiggsfieldImageModel | CloudflareModel | ArkModel
export type VideoModel = HiggsfieldVideoModel | ArkVideoModel

export const imageOptions: {
  id: ImageModel
  label: string
  /** Which controls the model supports; without aspect it renders 1:1. */
  aspect: boolean
  resolution: boolean
  /** Max reference images; omitted when the model takes none. */
  references?: number
  /** Generated within the API request (no queue); FLUX.2 and Seedream can take ~30s or more. */
  inline?: boolean
  /** Selectable inference step counts; the first-listed default is FLUX2_DEV_DEFAULT_STEPS. */
  steps?: number[]
}[] = [
  // { id: 'soulv2', label: 'Soul V2', aspect: true, resolution: true },
  // { id: 'soul', label: 'Soul', aspect: true, resolution: true },
  // { id: 'soulcinema', label: 'Soul Cinema', aspect: true, resolution: true },
  { id: 'fluxSchnell', label: 'FLUX 1', aspect: false, resolution: false, inline: true }
  // { id: 'seedream5Pro', label: 'Seedream 5 Pro', aspect: true, resolution: false, references: 10, inline: true },
  // { id: 'seedream5Flash', label: 'Seedream 5 Flash', aspect: true, resolution: false, references: 10, inline: true },
  // { id: 'flux2Klein', label: 'FLUX 2', aspect: true, resolution: false, references: 4, inline: true },
  // {
  //   id: 'flux2Dev',
  //   label: 'CF - FLUX.2 dev',
  //   aspect: true,
  //   resolution: false,
  //   references: 4,
  //   inline: true,
  //   steps: [10, FLUX2_DEV_DEFAULT_STEPS, 30]
  // }
]

// FLUX.2 takes 256–1920px per side; every size here is 2×2 tiles (klein ~104 neurons, dev ~150 per step).
const flux2Sizes: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 768, height: 1024 },
  '9:16': { width: 576, height: 1024 },
  '16:9': { width: 1024, height: 576 }
}

// Seedream 5 pro/flash take 921,600–4,624,220 total pixels; these are its 2K presets.
const seedreamSizes: Record<string, string> = {
  '1:1': '2048x2048',
  '3:4': '1728x2304',
  '9:16': '1440x2560',
  '16:9': '2560x1440'
}

export const videoOptions: {
  id: VideoModel
  label: string
  aspect: boolean
  image?: 'required' | 'optional'
  /** Generated within the API request (no queue), which stays open until the video is ready. */
  inline?: boolean
}[] = [
  { id: 'seedanceFast', label: 'Seedance 1.0 Pro Fast', aspect: true, image: 'optional', inline: true },
  // { id: 'seedanceText', label: 'Seedance 2.5', aspect: true },
  // { id: 'seedanceImage', label: 'Seedance 2.5 · Image', aspect: false, image: 'required' },
  { id: 'wanReference', label: 'Wan 3.0', aspect: true, image: 'optional' }
]

export const model3dOptions: {
  id: Ark3DModel
  label: string
  /** Photos of one object, in the order of `views`. */
  references: number
}[] = [{ id: 'hitem3d', label: 'Hitem3D 2.0', references: 4 }]

/** Hitem3D reads its reference photos in this order. */
export const views3d = ['Front', 'Back', 'Left', 'Right']
export const resolutions3d = ['1536'] as const // , '1536pro'
export type Resolution3D = (typeof resolutions3d)[number]
export const formats3d: Model3DFormat[] = ['glb'] // , 'obj', 'fbx', 'usdz', 'stl'

export const aspectRatios: Record<Exclude<Mode, '3d'>, string[]> = {
  image: ['1:1', '3:4', '9:16', '16:9'],
  video: ['16:9', '9:16', '1:1']
}

export const resolutions: Resolution[] = ['720p'] // , '1080p'
export const durations: Duration[] = [5] // , 10

export type Settings = {
  mode: Mode
  prompt: string
  imageModel: ImageModel
  videoModel: VideoModel
  aspect: string
  resolution: Resolution
  duration: Duration
  imageUrl: string
  /** Data URLs from toReferenceImage. */
  references: string[]
  /** Inference steps for models that offer a choice. */
  steps: number
  model3d: Ark3DModel
  resolution3d: Resolution3D
  /** Textured model, or geometry only. */
  texture: boolean
  format3d: Model3DFormat
}

const isUrl = (value: string) => /^https?:\/\/\S+$/.test(value)

/** Build the API request, or return a message describing what is missing. */
export function buildRequest(s: Settings): GenerateRequest | string {
  const prompt = s.prompt.trim()
  const imageUrl = s.imageUrl.trim()

  if (s.mode === 'image') {
    if (!prompt) return 'Describe the image you want.'
    if (s.imageModel === 'fluxSchnell') return { kind: 'image', model: 'fluxSchnell', input: { prompt } }
    if (s.imageModel === 'flux2Klein' || s.imageModel === 'flux2Dev') {
      const size = flux2Sizes[s.aspect] ?? flux2Sizes['1:1']
      const input = { prompt, ...size, ...(s.references.length && { reference_images: s.references }) }
      return s.imageModel === 'flux2Dev'
        ? { kind: 'image', model: 'flux2Dev', input: { ...input, steps: s.steps } }
        : { kind: 'image', model: 'flux2Klein', input }
    }
    if (s.imageModel === 'seedream5Pro' || s.imageModel === 'seedream5Flash') {
      const size = seedreamSizes[s.aspect] ?? seedreamSizes['1:1']
      return {
        kind: 'image',
        model: s.imageModel,
        input: { prompt, size, ...(s.references.length && { image: s.references }) }
      }
    }
    const input = { prompt, aspect_ratio: s.aspect as never, resolution: s.resolution }
    return { kind: 'image', model: s.imageModel, input } as GenerateRequest
  }

  if (s.mode === '3d') {
    if (!s.references.length) return 'Add 1–4 photos of the object: front, back, left, right.'
    return {
      kind: '3d',
      model: s.model3d,
      input: { images: s.references, resolution: s.resolution3d, texture: s.texture, format: s.format3d }
    }
  }

  if (imageUrl && !isUrl(imageUrl)) return 'Image URL must start with http(s)://'

  switch (s.videoModel) {
    case 'seedanceFast':
      if (!prompt && !imageUrl) return 'Describe the video you want, or add a start frame.'
      return {
        kind: 'video',
        model: 'seedanceFast',
        input: {
          duration: s.duration,
          resolution: s.resolution,
          ratio: s.aspect as never,
          ...(prompt && { prompt }),
          ...(imageUrl && { image_url: imageUrl })
        }
      }
    case 'seedanceImage':
      if (!imageUrl) return 'Add a start frame image URL.'
      return {
        kind: 'video',
        model: 'seedanceImage',
        input: { image_url: imageUrl, duration: s.duration, resolution: s.resolution, ...(prompt && { prompt }) }
      }
    case 'wanReference':
      if (!prompt) return 'Describe the video you want.'
      return {
        kind: 'video',
        model: 'wanReference',
        input: {
          prompt,
          duration: s.duration,
          resolution: s.resolution,
          aspect_ratio: s.aspect as never,
          ...(imageUrl && { image_urls: [imageUrl] })
        }
      }
    default:
      if (!prompt) return 'Describe the video you want.'
      return {
        kind: 'video',
        model: 'seedanceText',
        input: { prompt, duration: s.duration, resolution: s.resolution, aspect_ratio: s.aspect as never }
      }
  }
}

const isCloudflare = (request: GenerateRequest) =>
  request.model === 'fluxSchnell' || request.model === 'flux2Klein' || request.model === 'flux2Dev'

/** Neuron cost of the current settings before generating, or undefined for non-Cloudflare models. */
export function estimateSettingsNeurons(s: Settings): number | undefined {
  // The prompt does not affect cost; a placeholder keeps buildRequest from rejecting an empty one.
  const request = buildRequest({ ...s, prompt: s.prompt.trim() || 'x' })
  if (typeof request === 'string' || !isCloudflare(request)) return undefined
  return estimateNeurons(request as Parameters<typeof estimateNeurons>[0])
}

export type Job = {
  id: string
  runId?: string
  kind: Mode
  label: string
  prompt: string
  aspect: string
  status: 'pending' | 'done' | 'error'
  stage: string
  images?: string[]
  video?: string
  model3d?: Model3D
  error?: string
  /** Estimated Workers AI neurons spent (Cloudflare models only). */
  neurons?: number
}

/** Background runs return a runId to follow; fast providers return the images directly. */
export type GenerationStart =
  { runId: string } | { images: string[]; neurons?: number } | { video: string } | { model3d: Model3D }

export async function startGeneration(request: GenerateRequest): Promise<GenerationStart> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })
  const body = (await res.json().catch(() => ({}))) as Partial<{
    runId: string
    images: string[]
    neurons: number
    video: string
    model3d: Model3D
    error: string
  }>
  if (res.ok && body.runId) return { runId: body.runId }
  if (res.ok && body.images?.length) return { images: body.images, neurons: body.neurons }
  if (res.ok && body.video) return { video: body.video }
  if (res.ok && body.model3d) return { model3d: body.model3d }
  throw new Error(body.error ?? `Request failed (${res.status})`)
}

/** Ark's file host sends no CORS headers, so the browser reads model files through our API. */
export const proxiedFileUrl = (url: string) => `/api/files?url=${encodeURIComponent(url)}`

export async function fetchNeuronUsage(): Promise<NeuronUsage | undefined> {
  const res = await fetch('/api/usage/neurons').catch(() => undefined)
  return res?.ok ? ((await res.json()) as NeuronUsage) : undefined
}

export const formatNeurons = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: value < 100 ? 1 : 0 })

/**
 * Downscale an uploaded image as a data URL: JPEG at 512px by default (FLUX.2 caps references at
 * 512×512); 3D references use PNG, which keeps a cut-out object's transparent background.
 */
export async function toReferenceImage(
  file: File,
  maxSide = 512,
  type: 'image/jpeg' | 'image/png' = 'image/jpeg'
): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL(type, 0.9)
}

const stageLabel = (event: RunEvent) => {
  if (event.stage === 'generating') return 'Generating'
  if (event.stage === 'submitting') return 'Submitting'
  return event.status === 'QUEUED' || event.status === 'PENDING_VERSION' ? 'Queued' : 'Starting'
}

export const eventToPatch = (event: RunEvent): Partial<Job> =>
  event.done
    ? event.error
      ? { status: 'error', error: event.error }
      : { status: 'done', images: event.images, video: event.video }
    : { stage: stageLabel(event) }

/** Follow a run over SSE until it finishes; returns an unsubscribe function. */
export function subscribeToRun(runId: string, onEvent: (event: RunEvent) => void): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`)
  source.onmessage = (message) => {
    const event = JSON.parse(message.data) as RunEvent
    onEvent(event)
    if (event.done) source.close()
  }
  return () => source.close()
}
