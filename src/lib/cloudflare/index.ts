// Cloudflare Workers AI image generation (free daily allowance of 10,000 neurons).
// Ref: https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/
//      https://developers.cloudflare.com/changelog/2026-01-15-flux-2-klein-4b-workers-ai
// Server-side only: the API token must never reach the browser bundle.

import { Config, Effect, Option, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { execute } from '../runtime'
import { FLUX2_DEV_DEFAULT_STEPS, MAX_REFERENCE_IMAGES, estimateNeurons } from './pricing'

export * from './pricing'

export class CloudflareAIError extends Schema.TaggedError<CloudflareAIError>()('CloudflareAIError', {
  message: Schema.String,
  httpStatus: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown)
}) {}

const side = Schema.Int.check(Schema.isBetween({ minimum: 256, maximum: 1920 }))

export const FluxSchnellInput = Schema.Struct({
  prompt: Schema.String,
  /** Diffusion steps, max 8, default 4. Each step costs ~9.6 neurons. */
  steps: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8 }))),
  seed: Schema.optionalKey(Schema.Int)
})
export type FluxSchnellInput = typeof FluxSchnellInput.Type

const fluxKleinFields = {
  prompt: Schema.String,
  /** 256–1920, default 1024. */
  width: Schema.optionalKey(side),
  /** 256–1920, default 768. */
  height: Schema.optionalKey(side),
  seed: Schema.optionalKey(Schema.Int),
  guidance: Schema.optionalKey(Schema.Number),
  /** Up to 4 image data URLs, each at most 512×512; the prompt can refer to them as "image 1", "image 2", … */
  reference_images: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(MAX_REFERENCE_IMAGES)))
}

export const FluxKleinInput = Schema.Struct(fluxKleinFields)
export type FluxKleinInput = typeof FluxKleinInput.Type

/** Higher quality than klein but billed per step (~150 neurons per step at 1024×1024). */
export const FluxDevInput = Schema.Struct({
  ...fluxKleinFields,
  /** Inference steps; defaults to FLUX2_DEV_DEFAULT_STEPS. */
  steps: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0)))
})
export type FluxDevInput = typeof FluxDevInput.Type

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
export const CloudflareRequest = Schema.Union([
  Schema.Struct({ model: Schema.Literal('fluxSchnell'), input: FluxSchnellInput }),
  Schema.Struct({ model: Schema.Literal('flux2Klein'), input: FluxKleinInput }),
  Schema.Struct({ model: Schema.Literal('flux2Dev'), input: FluxDevInput })
])
export type CloudflareRequest = typeof CloudflareRequest.Type

const RunResponse = Schema.Struct({
  success: Schema.optionalKey(Schema.Boolean),
  result: Schema.optionalKey(Schema.Struct({ image: Schema.optionalKey(Schema.String) })),
  errors: Schema.optionalKey(Schema.Array(Schema.Struct({ message: Schema.optionalKey(Schema.String) })))
})

const AnalyticsResponse = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        viewer: Schema.Struct({
          accounts: Schema.Array(
            Schema.Struct({
              // null alongside `errors` when the token lacks Account Analytics access.
              aiInferenceAdaptiveGroups: Schema.NullOr(
                Schema.Array(Schema.Struct({ sum: Schema.Struct({ totalNeurons: Schema.Number }) }))
              )
            })
          )
        })
      })
    )
  ),
  errors: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String }))))
})

const credentials = Config.all({
  accountId: Config.String('CLOUDFLARE_ACCOUNT_ID'),
  apiToken: Config.Redacted('CLOUDFLARE_API_TOKEN')
}).pipe(
  Effect.mapError(
    () => new CloudflareAIError({ message: 'Missing Cloudflare credentials: set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN' })
  )
)

// Lenient: a body that does not match still yields its status-based error message.
const decodeBody = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, body: unknown): S['Type'] | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(schema)(body))

// Workers AI returns bare base64; sniff the format from its magic bytes.
const mimeType = (base64: string) =>
  base64.startsWith('iVBOR') ? 'image/png' : base64.startsWith('UklGR') ? 'image/webp' : 'image/jpeg'

const dataUrlToBlob = (dataUrl: string) => {
  const match = dataUrl.match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
  return match
    ? Effect.succeed(new Blob([Buffer.from(match[2], 'base64')], { type: match[1] }))
    : Effect.fail(new CloudflareAIError({ message: 'Reference images must be base64 image data URLs' }))
}

// FLUX.2 takes multipart form data, even for a prompt alone; references must be named input_image_N.
const flux2Form = ({ reference_images = [], ...fields }: FluxKleinInput | FluxDevInput) =>
  Effect.gen(function* () {
    if (reference_images.length > MAX_REFERENCE_IMAGES) {
      return yield* new CloudflareAIError({ message: `At most ${MAX_REFERENCE_IMAGES} reference images are supported` })
    }
    const form = new FormData()
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) form.append(key, String(value))
    }
    for (const [index, image] of reference_images.entries()) {
      form.append(`input_image_${index}`, yield* dataUrlToBlob(image), `ref-${index}`)
    }
    return form
  })

export type CloudflareImage = { image: string; neurons: number }

/** Generate one image; returns it as a data URL with its estimated neuron cost. */
export const generateCloudflareImage = Effect.fn('Cloudflare.generateImage')(function* (request: CloudflareRequest) {
  const { accountId, apiToken } = yield* credentials
  // Send dev's step count explicitly so the cost estimate always matches what ran.
  if (request.model === 'flux2Dev') request = { ...request, input: { steps: FLUX2_DEV_DEFAULT_STEPS, ...request.input } }
  const base = HttpClientRequest.post(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${cloudflareModels[request.model]}`
  ).pipe(HttpClientRequest.bearerToken(apiToken))
  // The FormData body lets fetch set the multipart boundary itself.
  const req =
    request.model === 'fluxSchnell'
      ? HttpClientRequest.bodyJsonUnsafe(base, request.input)
      : HttpClientRequest.bodyFormData(base, yield* flux2Form(request.input))

  const res = yield* execute(req).pipe(
    Effect.mapError((cause) => new CloudflareAIError({ message: `Cloudflare ${request.model} failed: ${cause.message}` }))
  )
  const json = decodeBody(RunResponse, res.body)
  const image = json?.result?.image
  if (!res.ok || json?.success === false || !image) {
    const reason = json?.errors?.map((e) => e.message).filter(Boolean).join('; ')
    return yield* new CloudflareAIError({
      message: `Cloudflare ${request.model} failed with ${res.status}${reason ? `: ${reason}` : ''}`,
      httpStatus: res.status,
      body: res.body
    })
  }
  return { image: `data:${mimeType(image)};base64,${image}`, neurons: estimateNeurons(request) } satisfies CloudflareImage
})

/**
 * Neurons used today (UTC) across the whole account, from Cloudflare's analytics.
 * Needs the API token to have Account Analytics: Read; figures can lag a few minutes.
 */
export const fetchNeuronsUsedToday = Effect.fn('Cloudflare.fetchNeuronsUsedToday')(function* () {
  const { accountId, apiToken } = yield* credentials
  const res = yield* HttpClientRequest.post('https://api.cloudflare.com/client/v4/graphql').pipe(
    HttpClientRequest.bearerToken(apiToken),
    HttpClientRequest.bodyJsonUnsafe({
      query: `query($account: String!, $date: Date!) { viewer { accounts(filter: { accountTag: $account }) {
        aiInferenceAdaptiveGroups(limit: 100, filter: { date: $date }) { sum { totalNeurons } }
      } } }`,
      variables: { account: accountId, date: new Date().toISOString().slice(0, 10) }
    }),
    execute,
    Effect.mapError((cause) => new CloudflareAIError({ message: `Cloudflare analytics failed: ${cause.message}` }))
  )
  const json = decodeBody(AnalyticsResponse, res.body)
  const groups = json?.data?.viewer.accounts[0]?.aiInferenceAdaptiveGroups
  if (!res.ok || json?.errors?.length || !groups) {
    return yield* new CloudflareAIError({
      message: `Cloudflare analytics failed: ${json?.errors?.map((e) => e.message).join('; ') || res.status}`,
      httpStatus: res.status,
      body: res.body
    })
  }
  return groups.reduce((total, group) => total + group.sum.totalNeurons, 0)
})
