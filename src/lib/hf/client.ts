// Thin REST client for the Higgsfield API.
// Ref: https://docs.higgsfield.ai/docs/api-reference/overview
// Server-side only: credentials must never reach the browser bundle.

import { Config, Effect, Option, Redacted, Schedule, Schema } from 'effect'
import { HttpClientRequest } from 'effect/http'
import { execute } from '../runtime'

const BASE_URL = 'https://api.higgsfield.ai'

export const RequestStatus = Schema.Literals(['queued', 'in_progress', 'completed', 'failed', 'nsfw', 'canceled'])
export type RequestStatus = typeof RequestStatus.Type

const TERMINAL: ReadonlySet<RequestStatus> = new Set(['completed', 'failed', 'nsfw', 'canceled'])

export const MediaUrl = Schema.Struct({ url: Schema.String })
export type MediaUrl = typeof MediaUrl.Type

export const QueuedRequest = Schema.Struct({
  status: RequestStatus,
  request_id: Schema.String,
  status_url: Schema.String,
  cancel_url: Schema.String,
  /** Seconds the request data is retained after it finishes. */
  expires_after: Schema.optionalKey(Schema.Number)
})
export type QueuedRequest = typeof QueuedRequest.Type

export const RequestResult = Schema.Struct({
  status: RequestStatus,
  request_id: Schema.String,
  expires_at: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Unknown),
  images: Schema.optionalKey(Schema.Array(MediaUrl)),
  video: Schema.optionalKey(MediaUrl)
})
export type RequestResult = typeof RequestResult.Type

export class HiggsfieldError extends Schema.TaggedError<HiggsfieldError>()('HiggsfieldError', {
  message: Schema.String,
  httpStatus: Schema.optional(Schema.Number),
  body: Schema.optional(Schema.Unknown),
  result: Schema.optional(RequestResult)
}) {}

// Accepts HF_CREDENTIALS="KEY_ID:KEY_SECRET" or the documented HF_API_KEY_ID / HF_API_KEY_SECRET pair.
const credentials = Config.Redacted('HF_CREDENTIALS').pipe(
  Config.orElse(() =>
    Config.all([Config.String('HF_API_KEY_ID'), Config.Redacted('HF_API_KEY_SECRET')]).pipe(
      Config.map(([id, secret]) => Redacted.make(`${id}:${Redacted.value(secret)}`))
    )
  )
)

const authHeader = credentials.pipe(
  Effect.map((key) => `Key ${Redacted.value(key)}`),
  Effect.mapError(() => new HiggsfieldError({ message: 'Missing Higgsfield credentials: set HF_CREDENTIALS="KEY_ID:KEY_SECRET"' }))
)

const isRetryable = (error: HiggsfieldError) =>
  error.httpStatus === undefined || error.httpStatus === 429 || error.httpStatus >= 500

const request = <S extends Schema.Constraint>(
  schema: S,
  method: 'GET' | 'POST',
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {}
) =>
  Effect.gen(function* () {
    const endpoint = path.split('?')[0]
    const label = `Higgsfield ${method} ${endpoint}`
    const res = yield* HttpClientRequest.make(method)(`${BASE_URL}${path}`).pipe(
      HttpClientRequest.setHeaders({ Authorization: yield* authHeader, 'Content-Type': 'application/json', ...options.headers }),
      options.body === undefined ? (req) => req : HttpClientRequest.bodyJsonUnsafe(options.body),
      execute,
      // Network failures carry no status, so they count as retryable.
      Effect.mapError((cause) => new HiggsfieldError({ message: `${label} failed: ${cause.message}` }))
    )
    if (!res.ok) {
      const detail = typeof res.body === 'string' ? res.body : (res.body as { detail?: unknown } | undefined)?.detail
      const reason = detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''
      return yield* new HiggsfieldError({ message: `${label} failed with ${res.status}${reason}`, httpStatus: res.status, body: res.body })
    }
    return yield* Schema.decodeUnknownEffect(schema)(res.body).pipe(
      Effect.mapError(
        (error) => new HiggsfieldError({ message: `${label} returned an unexpected response: ${error.message}`, body: res.body })
      )
    )
  })

export type SubmitOptions = {
  /** Reused across retries so a timed-out submit never creates a duplicate job. */
  idempotencyKey?: string
  /** Higgsfield POSTs the final result here instead of you polling. */
  webhookUrl?: string
  maxRetries?: number
  /** Base delay in ms for exponential backoff between submit retries. */
  retryDelay?: number
}

/** Queue a generation and return immediately with its request id. */
export const submit = (
  endpoint: string,
  input: object,
  { idempotencyKey = crypto.randomUUID(), webhookUrl, maxRetries = 3, retryDelay = 1000 }: SubmitOptions = {}
) => {
  const query = webhookUrl ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : ''
  return request(QueuedRequest, 'POST', `/${endpoint}${query}`, {
    headers: { 'Idempotency-Key': idempotencyKey },
    body: input
  }).pipe(
    Effect.retry({
      // Exponential backoff, capped at 30s between attempts.
      schedule: Schedule.min([Schedule.exponential(retryDelay), Schedule.spaced('30 seconds')]),
      times: maxRetries,
      while: isRetryable
    }),
    Effect.withSpan('Higgsfield.submit', { attributes: { endpoint } })
  )
}

export const getStatus = (requestId: string) => request(RequestResult, 'GET', `/requests/${requestId}/status`)

/** Only queued requests can be canceled; fails (400) once processing has started. */
export const cancel = (requestId: string) =>
  request(Schema.Unknown, 'POST', `/requests/${requestId}/cancel`).pipe(Effect.asVoid)

export type WaitOptions = {
  pollInterval?: number
  maxPollInterval?: number
  timeout?: number
  onStatus?: (result: RequestResult) => void
}

/** Poll with backoff until the request reaches a terminal status. Interrupt the effect to stop early. */
export const waitFor = (
  requestId: string,
  { pollInterval = 2000, maxPollInterval = 15_000, timeout = 5 * 60_000, onStatus }: WaitOptions = {}
) =>
  Effect.gen(function* () {
    let interval = pollInterval
    while (true) {
      // Transient failures (5xx, 429, network) are skipped; the next poll tries again.
      const result = yield* getStatus(requestId).pipe(
        Effect.map(Option.some),
        Effect.catchIf(isRetryable, () => Effect.succeedNone)
      )
      if (Option.isSome(result)) {
        onStatus?.(result.value)
        if (TERMINAL.has(result.value.status)) return result.value
      }
      yield* Effect.sleep(interval)
      interval = Math.min(interval * 1.5, maxPollInterval)
    }
  }).pipe(
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.fail(new HiggsfieldError({ message: `Request ${requestId} did not finish within ${timeout}ms` }))
    }),
    Effect.withSpan('Higgsfield.waitFor', { attributes: { requestId } })
  )

export type RunOptions = SubmitOptions & WaitOptions

/** Submit, wait, and fail unless the request completed. */
export const run = (endpoint: string, input: object, options: RunOptions = {}) =>
  Effect.gen(function* () {
    const { request_id } = yield* submit(endpoint, input, options)
    const result = yield* waitFor(request_id, options)
    if (result.status !== 'completed') {
      return yield* new HiggsfieldError({
        message: `Request ${request_id} ended with status "${result.status}"`,
        body: result.error,
        result
      })
    }
    return result
  })
