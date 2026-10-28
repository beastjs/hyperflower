// Workers AI neuron pricing for the image models we use. Pure, so the browser can show
// costs before generating. Rates: https://developers.cloudflare.com/workers-ai/platform/pricing/

export const FREE_DAILY_NEURONS = 10_000
export const MAX_REFERENCE_IMAGES = 4
/** FLUX.2 dev has no documented default step count, so we always send one. */
export const FLUX2_DEV_DEFAULT_STEPS = 20

type PricedRequest =
  | { model: 'fluxSchnell'; input: { steps?: number } }
  | { model: 'flux2Klein'; input: { width?: number; height?: number; reference_images?: ReadonlyArray<string> } }
  | { model: 'flux2Dev'; input: { width?: number; height?: number; steps?: number; reference_images?: ReadonlyArray<string> } }

const tiles = (width: number, height: number) => Math.ceil(width / 512) * Math.ceil(height / 512)
const round = (value: number) => Math.round(value * 100) / 100

/** Estimated neuron cost of one generation (schnell always renders 1024×1024; references are ≤512px, one tile each). */
export function estimateNeurons(request: PricedRequest): number {
  if (request.model === 'fluxSchnell') return round(tiles(1024, 1024) * 4.8 + (request.input.steps ?? 4) * 9.6)

  const { width = 1024, height = 768, reference_images = [] } = request.input
  if (request.model === 'flux2Klein') return round(reference_images.length * 5.37 + tiles(width, height) * 26.05)

  const steps = request.input.steps ?? FLUX2_DEV_DEFAULT_STEPS
  return round(steps * (reference_images.length * 18.75 + tiles(width, height) * 37.5))
}
