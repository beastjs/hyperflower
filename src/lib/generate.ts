// Browser-side helpers for the generation UI. Type-only imports keep hf/server code out of the bundle.
import type { GenerateRequest, NeuronUsage, RunEvent } from '@/server/api'
import type { CloudflareModel } from './cloudflare'
import type { ImageModel as HiggsfieldImageModel, VideoModel } from './hf'

export type Mode = 'image' | 'video'
export type Resolution = '720p' | '1080p'
export type Duration = 5 | 10
export type ImageModel = HiggsfieldImageModel | CloudflareModel

export const imageOptions: {
  id: ImageModel
  label: string
  /** Which controls the model supports; without aspect it renders 1:1. */
  aspect: boolean
  resolution: boolean
  /** Max reference images; omitted when the model takes none. */
  references?: number
  /** Generated within the API request (no queue); FLUX.2 klein can take ~30s. */
  inline?: boolean
}[] = [
  // { id: 'soulv2', label: 'Soul V2', aspect: true, resolution: true },
  // { id: 'soul', label: 'Soul', aspect: true, resolution: true },
  // { id: 'soulcinema', label: 'Soul Cinema', aspect: true, resolution: true },
  { id: 'fluxSchnell', label: 'CF - FLUX.1', aspect: false, resolution: false, inline: true },
  { id: 'flux2Klein', label: 'CF - FLUX.2 klein', aspect: true, resolution: false, references: 4, inline: true }
]

// FLUX.2 klein takes 256–1920px per side; every size here is 2×2 tiles (~104 neurons).
const kleinSizes: Record<string, { width: number; height: number }> = {
  '1:1': { width: 1024, height: 1024 },
  '3:4': { width: 768, height: 1024 },
  '9:16': { width: 576, height: 1024 },
  '16:9': { width: 1024, height: 576 }
}

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
  /** Data URLs from toReferenceImage. */
  references: string[]
}

const isUrl = (value: string) => /^https?:\/\/\S+$/.test(value)

/** Build the API request, or return a message describing what is missing. */
export function buildRequest(s: Settings): GenerateRequest | string {
  const prompt = s.prompt.trim()
  const imageUrl = s.imageUrl.trim()

  if (s.mode === 'image') {
    if (!prompt) return 'Describe the image you want.'
    if (s.imageModel === 'fluxSchnell') return { kind: 'image', model: 'fluxSchnell', input: { prompt } }
    if (s.imageModel === 'flux2Klein') {
      const size = kleinSizes[s.aspect] ?? kleinSizes['1:1']
      const input = { prompt, ...size, ...(s.references.length && { reference_images: s.references }) }
      return { kind: 'image', model: 'flux2Klein', input }
    }
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
  /** Estimated Workers AI neurons spent (Cloudflare models only). */
  neurons?: number
}

/** Background runs return a runId to follow; fast providers return the images directly. */
export type GenerationStart = { runId: string } | { images: string[]; neurons?: number }

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
    error: string
  }>
  if (res.ok && body.runId) return { runId: body.runId }
  if (res.ok && body.images?.length) return { images: body.images, neurons: body.neurons }
  throw new Error(body.error ?? `Request failed (${res.status})`)
}

export async function fetchNeuronUsage(): Promise<NeuronUsage | undefined> {
  const res = await fetch('/api/usage/neurons').catch(() => undefined)
  return res?.ok ? ((await res.json()) as NeuronUsage) : undefined
}

export const formatNeurons = (value: number) =>
  value.toLocaleString(undefined, { maximumFractionDigits: value < 100 ? 1 : 0 })

/** Downscale an uploaded image to fit FLUX.2's 512×512 reference limit, as a JPEG data URL. */
export async function toReferenceImage(file: File, maxSide = 512): Promise<string> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  return canvas.toDataURL('image/jpeg', 0.9)
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
