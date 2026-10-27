// Cloudflare Workers AI image generation (free daily allowance of 10,000 neurons).
// Ref: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
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

export const cloudflareModels = {
  fluxSchnell: '@cf/black-forest-labs/flux-1-schnell'
} as const

export type CloudflareInputMap = {
  fluxSchnell: FluxSchnellInput
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

/** Generate one image and return it as a data URL. */
export async function generateCloudflareImage<M extends CloudflareModel>(
  model: M,
  input: CloudflareInputMap[M]
): Promise<string> {
  const { accountId, apiToken } = credentials()
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${cloudflareModels[model]}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    }
  )

  const body = (await res.json().catch(() => undefined)) as RunResponse | undefined
  const image = body?.result?.image
  if (!res.ok || body?.success === false || !image) {
    const reason = body?.errors?.map((e) => e.message).filter(Boolean).join('; ')
    throw new CloudflareAIError(
      `Cloudflare ${model} failed with ${res.status}${reason ? `: ${reason}` : ''}`,
      res.status,
      body
    )
  }
  return `data:${mimeType(image)};base64,${image}`
}
