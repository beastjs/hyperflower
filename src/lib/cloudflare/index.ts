// Cloudflare Workers AI image generation (free daily allowance of 10,000 neurons).
// Ref: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
//      https://developers.cloudflare.com/changelog/2026-01-15-flux-2-klein-4b-workers-ai
// Server-side only: the API token must never reach the browser bundle.

import { FLUX2_DEV_DEFAULT_STEPS, MAX_REFERENCE_IMAGES, estimateNeurons } from './pricing'

export * from './pricing'

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

/** Higher quality than klein but billed per step (~150 neurons per step at 1024×1024). */
export type FluxDevInput = FluxKleinInput & {
  /** Inference steps; defaults to FLUX2_DEV_DEFAULT_STEPS. */
  steps?: number
}

export const cloudflareModels = {
  fluxSchnell: '@cf/black-forest-labs/flux-1-schnell',
  flux2Klein: '@cf/black-forest-labs/flux-2-klein-4b',
  flux2Dev: '@cf/black-forest-labs/flux-2-dev'
} as const

export type CloudflareInputMap = {
  fluxSchnell: FluxSchnellInput
  flux2Klein: FluxKleinInput
  flux2Dev: FluxDevInput
}

export type CloudflareModel = keyof CloudflareInputMap

/** A model paired with its matching input, e.g. for task payloads. */
export type CloudflareRequest = {
  [M in CloudflareModel]: { model: M; input: CloudflareInputMap[M] }
}[CloudflareModel]

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
const flux2Form = ({ reference_images = [], ...fields }: FluxKleinInput | FluxDevInput) => {
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
  // Send dev's step count explicitly so the cost estimate always matches what ran.
  if (request.model === 'flux2Dev') request = { ...request, input: { steps: FLUX2_DEV_DEFAULT_STEPS, ...request.input } }
  const body = request.model === 'fluxSchnell' ? JSON.stringify(request.input) : flux2Form(request.input)
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
