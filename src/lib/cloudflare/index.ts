// Cloudflare Workers AI image generation (free daily allowance of 10,000 neurons).
// Ref: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
//      https://developers.cloudflare.com/changelog/2026-01-15-flux-2-klein-4b-workers-ai
// Server-side only: the API token must never reach the browser bundle.

export class CloudflareAIError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown
  ) {
    super(message)
    this.name = 'CloudflareAIError'
  }
}

export type FluxSchnellInput = {
  prompt: string
  /** Diffusion steps, max 8, default 4. Each step costs ~9.6 neurons. */
  steps?: number
  seed?: number
}

export type FluxKleinInput = {
  prompt: string
  /** 256–1920, default 1024. */
  width?: number
  /** 256–1920, default 768. */
  height?: number
  seed?: number
  guidance?: number
  /** Up to 4 image data URLs, each at most 512×512; the prompt can refer to them as "image 1", "image 2", … */
  reference_images?: string[]
}

export const cloudflareModels = {
  fluxSchnell: '@cf/black-forest-labs/flux-1-schnell',
  flux2Klein: '@cf/black-forest-labs/flux-2-klein-4b'
} as const

export type CloudflareInputMap = {
  fluxSchnell: FluxSchnellInput
  flux2Klein: FluxKleinInput
}

export type CloudflareModel = keyof CloudflareInputMap

/** A model paired with its matching input, e.g. for task payloads. */
export type CloudflareRequest = {
  [M in CloudflareModel]: { model: M; input: CloudflareInputMap[M] }
}[CloudflareModel]

export const FREE_DAILY_NEURONS = 10_000
export const MAX_REFERENCE_IMAGES = 4

// Published rates per 512×512 tile and per step: https://developers.cloudflare.com/workers-ai/platform/pricing/
const tiles = (width: number, height: number) => Math.ceil(width / 512) * Math.ceil(height / 512)

/** Estimated neuron cost of one generation (schnell always renders 1024×1024). */
export function estimateNeurons(request: CloudflareRequest): number {
  const neurons =
    request.model === 'fluxSchnell'
      ? tiles(1024, 1024) * 4.8 + (request.input.steps ?? 4) * 9.6
      : (request.input.reference_images?.length ?? 0) * 5.37 +
        tiles(request.input.width ?? 1024, request.input.height ?? 768) * 26.05
  return Math.round(neurons * 100) / 100
}

type RunResponse = {
  success?: boolean
  result?: { image?: string }
  errors?: { code?: number; message?: string }[]
}

const credentials = () => {
  const { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: apiToken } = process.env
  if (!accountId || !apiToken) {
    throw new CloudflareAIError('Missing Cloudflare credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN')
  }
  return { accountId, apiToken }
}

// Workers AI returns bare base64; sniff the format from its magic bytes.
const mimeType = (base64: string) =>
  base64.startsWith('iVBOR') ? 'image/png' : base64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg'

const dataUrlToBlob = (dataUrl: string) => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
  if (!match) throw new CloudflareAIError('Reference images must be base64 image data URLs')
  return new Blob([Buffer.from(match[2], 'base64')], { type: match[1] })
}

// FLUX.2 takes multipart form data, even for a prompt alone; references must be named input_image_N.
const kleinForm = ({ reference_images = [], ...fields }: FluxKleinInput) => {
  if (reference_images.length > MAX_REFERENCE_IMAGES) {
    throw new CloudflareAIError(`At most ${MAX_REFERENCE_IMAGES} reference images are supported`)
  }
  const form = new FormData()
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) form.append(key, String(value))
  }
  reference_images.forEach((image, index) => form.append(`input_image_${index}`, dataUrlToBlob(image), `ref-${index}`))
  return form
}

export type CloudflareImage = { image: string; neurons: number }

/** Generate one image; returns it as a data URL with its estimated neuron cost. */
export async function generateCloudflareImage(request: CloudflareRequest): Promise<CloudflareImage> {
  const { accountId, apiToken } = credentials()
  const body = request.model === 'flux2Klein' ? kleinForm(request.input) : JSON.stringify(request.input)
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${cloudflareModels[request.model]}`,
    {
      method: 'POST',
      // fetch sets the multipart boundary itself for FormData bodies.
      headers: { Authorization: `Bearer ${apiToken}`, ...(typeof body === 'string' && { 'Content-Type': 'application/json' }) },
      body
    }
  )

  const json = (await res.json().catch(() => undefined)) as RunResponse | undefined
  const image = json?.result?.image
  if (!res.ok || json?.success === false || !image) {
    const reason = json?.errors?.map((e) => e.message).filter(Boolean).join('; ')
    throw new CloudflareAIError(
      `Cloudflare ${request.model} failed with ${res.status}${reason ? `: ${reason}` : ''}`,
      res.status,
      json
    )
  }
  return { image: `data:${mimeType(image)};base64,${image}`, neurons: estimateNeurons(request) }
}

/**
 * Neurons used today (UTC) across the whole account, from Cloudflare's analytics.
 * Needs the API token to have Account Analytics: Read; figures can lag a few minutes.
 */
export async function fetchNeuronsUsedToday(): Promise<number> {
  const { accountId, apiToken } = credentials()
  const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `query($account: String!, $date: Date!) { viewer { accounts(filter: { accountTag: $account }) {
        aiInferenceAdaptiveGroups(limit: 100, filter: { date: $date }) { sum { totalNeurons } }
      } } }`,
      variables: { account: accountId, date: new Date().toISOString().slice(0, 10) }
    })
  })
  type Groups = { sum: { totalNeurons: number } }[]
  const json = (await res.json().catch(() => undefined)) as
    | { data?: { viewer?: { accounts?: { aiInferenceAdaptiveGroups?: Groups }[] } }; errors?: { message: string }[] | null }
    | undefined
  const groups = json?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups
  if (!res.ok || json?.errors?.length || !groups) {
    throw new CloudflareAIError(
      `Cloudflare analytics failed: ${json?.errors?.map((e) => e.message).join('; ') || res.status}`,
      res.status,
      json
    )
  }
  return groups.reduce((total, group) => total + group.sum.totalNeurons, 0)
}
