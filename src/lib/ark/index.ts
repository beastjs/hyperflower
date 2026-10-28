// BytePlus ModelArk image generation (Seedream).
// Ref: https://ai.byteplus.com/ark/region:ap-southeast-1/docs/image-generation-api
// Server-side only: the API key must never reach the browser bundle.

export class ArkError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'ArkError'
  }
}

export const MAX_ARK_REFERENCE_IMAGES = 10

export type SeedreamInput = {
  prompt: string
  /** "1K" | "1.5K" | "2K", or "WxH" with 921,600–4,624,220 total pixels; default "2K". */
  size?: string
  /** Up to 10 image URLs or base64 data URLs; the prompt can refer to them as "image 1", "image 2", … */
  image?: string[]
  output_format?: 'png' | 'jpeg'
  /** Adds an "AI generated" mark in the lower-right corner; default true. */
  watermark?: boolean
}

export const arkModels = {
  seedream5Pro: 'dola-seedream-5-0-pro-260628',
  seedream5Flash: 'dola-seedream-5-0-flash-260915'
} as const

export type ArkModel = keyof typeof arkModels

/** A model paired with its matching input, e.g. for task payloads. */
export type ArkRequest = { model: ArkModel; input: SeedreamInput }

type GenerationResponse = {
  data?: { url?: string; error?: { message?: string } }[]
  error?: { code?: string; message?: string }
}

const credentials = () => {
  const { ARK_API_KEY: apiKey, ARK_BASE_URL: baseUrl = 'https://ark.ap-southeast.bytepluses.com/api/v3' } = process.env
  if (!apiKey) throw new ArkError('Missing BytePlus credentials: set ARK_API_KEY')
  return { apiKey, baseUrl: baseUrl.replace(/\/+$/, '') }
}

/** Generate one image; returns its URL, which Ark keeps for 24 hours. */
export async function generateArkImage({ model, input }: ArkRequest): Promise<string> {
  const { apiKey, baseUrl } = credentials()
  const { image = [], ...fields } = input
  if (image.length > MAX_ARK_REFERENCE_IMAGES) {
    throw new ArkError(`At most ${MAX_ARK_REFERENCE_IMAGES} reference images are supported`)
  }
  const res = await fetch(`${baseUrl}/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: arkModels[model],
      watermark: false,
      ...fields,
      ...(image.length && { image }),
      response_format: 'url'
    })
  })

  const json = (await res.json().catch(() => undefined)) as GenerationResponse | undefined
  const url = json?.data?.[0]?.url
  if (!res.ok || !url) {
    const reason = json?.error?.message ?? json?.data?.[0]?.error?.message
    throw new ArkError(`Ark ${model} failed with ${res.status}${reason ? `: ${reason}` : ''}`, res.status, json)
  }
  return url
}

export type SeedanceInput = {
  prompt?: string
  /** Start frame, as a URL or base64 data URL; the video then keeps its aspect ratio. */
  image_url?: string
  resolution?: '480p' | '720p' | '1080p'
  /** Ignored with a start frame, which uses "adaptive". */
  ratio?: '16:9' | '4:3' | '1:1' | '3:4' | '9:16' | '21:9'
  /** 2–12 seconds, default 5. */
  duration?: number
  /** Adds an "AI generated" mark; default false here. */
  watermark?: boolean
}

export const arkVideoModels = {
  seedanceFast: 'seedance-1-0-pro-fast-251015'
} as const

export type ArkVideoModel = keyof typeof arkVideoModels

export type ArkVideoRequest = { model: ArkVideoModel; input: SeedanceInput }

type VideoTask = {
  id?: string
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'expired'
  content?: { video_url?: string }
  error?: { code?: string; message?: string }
}

const arkFetch = async (path: string, init?: RequestInit) => {
  const { apiKey, baseUrl } = credentials()
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
  })
  const json = (await res.json().catch(() => undefined)) as VideoTask | undefined
  if (!res.ok) {
    const reason = json?.error?.message
    throw new ArkError(`Ark ${path} failed with ${res.status}${reason ? `: ${reason}` : ''}`, res.status, json)
  }
  return json ?? {}
}

/** Generate one video, polling the task until it finishes; returns its URL, which Ark keeps for 24 hours. */
export async function generateArkVideo(
  { model, input }: ArkVideoRequest,
  { interval = 3_000, timeout = 10 * 60_000 } = {}
): Promise<string> {
  const { prompt, image_url, ratio, watermark = false, ...fields } = input
  if (!prompt && !image_url) throw new ArkError('A prompt or start frame is required')
  const content = [
    ...(prompt ? [{ type: 'text', text: prompt }] : []),
    ...(image_url ? [{ type: 'image_url', image_url: { url: image_url }, role: 'first_frame' }] : [])
  ]
  const { id } = await arkFetch('/contents/generations/tasks', {
    method: 'POST',
    body: JSON.stringify({ model: arkVideoModels[model], content, ratio: image_url ? 'adaptive' : ratio, watermark, ...fields })
  })
  if (!id) throw new ArkError(`Ark ${model} returned no task id`)

  for (const deadline = Date.now() + timeout; Date.now() < deadline; ) {
    await new Promise((resolve) => setTimeout(resolve, interval))
    const task = await arkFetch(`/contents/generations/tasks/${encodeURIComponent(id)}`)
    if (task.status === 'succeeded' && task.content?.video_url) return task.content.video_url
    if (task.status && !['queued', 'running'].includes(task.status)) {
      const reason = task.error?.message
      throw new ArkError(`Ark ${model} task ${task.status}${reason ? `: ${reason}` : ''}`, undefined, task)
    }
  }
  throw new ArkError(`Ark ${model} task ${id} timed out`)
}
