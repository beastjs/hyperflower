// Browser-side helpers for the generation UI. Type-only imports keep hf/server code out of the bundle.
import type { GenerateRequest, RunEvent } from '@/server/api'
import type { CloudflareModel } from './cloudflare'
import type { ImageModel as HiggsfieldImageModel, VideoModel } from './hf'

export type Mode = 'image' | 'video'
export type Resolution = '720p' | '1080p'
export type Duration = 5 | 10
export type ImageModel = HiggsfieldImageModel | CloudflareModel

export const imageOptions: {
  id: ImageModel
  label: string
  /** Fixed output shape when the model has no aspect/resolution controls. */
  square?: boolean
}[] = [
  // { id: 'soulv2', label: 'Soul V2' },
  // { id: 'soul', label: 'Soul' },
  // { id: 'soulcinema', label: 'Soul Cinema' },
  { id: 'fluxSchnell', label: 'CF - FLUX.1', square: true }
]

export const videoOptions: {
  id: VideoModel
  label: string
  aspect: boolean
  image?: 'required' | 'optional'
}[] = [
  { id: 'seedanceText', label: 'Seedance 2.5', aspect: true },
  { id: 'seedanceImage', label: 'Seedance 2.5 · Image', aspect: false, image: 'required' },
  { id: 'wanReference', label: 'Wan 3.0', aspect: true, image: 'optional' }
]

export const aspectRatios: Record<Mode, string[]> = {
  image: ['1:1', '3:4', '9:16', '16:9'],
  video: ['16:9', '9:16', '1:1']
}

export const resolutions: Resolution[] = ['720p', '1080p']
export const durations: Duration[] = [5, 10]

export type Settings = {
  mode: Mode
  prompt: string
  imageModel: ImageModel
  videoModel: VideoModel
  aspect: string
  resolution: Resolution
  duration: Duration
  imageUrl: string
}

const isUrl = (value: string) => /^https?:\/\/\S+$/.test(value)

/** Build the API request, or return a message describing what is missing. */
export function buildRequest(s: Settings): GenerateRequest | string {
  const prompt = s.prompt.trim()
  const imageUrl = s.imageUrl.trim()

  if (s.mode === 'image') {
    if (!prompt) return 'Describe the image you want.'
    if (s.imageModel === 'fluxSchnell') return { kind: 'image', model: 'fluxSchnell', input: { prompt } }
    const input = { prompt, aspect_ratio: s.aspect as never, resolution: s.resolution }
    return { kind: 'image', model: s.imageModel, input } as GenerateRequest
  }

  if (imageUrl && !isUrl(imageUrl)) return 'Image URL must start with http(s)://'

  switch (s.videoModel) {
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
  error?: string
}

/** Background runs return a runId to follow; fast providers return the images directly. */
export type GenerationStart = { runId: string } | { images: string[] }

export async function startGeneration(request: GenerateRequest): Promise<GenerationStart> {
  const res = await fetch('/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  })
  const body = (await res.json().catch(() => ({}))) as Partial<{ runId: string; images: string[]; error: string }>
  if (res.ok && body.runId) return { runId: body.runId }
  if (res.ok && body.images?.length) return { images: body.images }
  throw new Error(body.error ?? `Request failed (${res.status})`)
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
