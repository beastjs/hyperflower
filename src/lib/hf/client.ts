// Thin REST client for the Higgsfield API.
// Ref: https://docs.higgsfield.ai/docs/api-reference/overview
// Server-side only: credentials must never reach the browser bundle.

const BASE_URL = 'https://api.higgsfield.ai'

export type RequestStatus =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'nsfw'
  | 'canceled'

const TERMINAL: ReadonlySet<RequestStatus> = new Set(['completed', 'failed', 'nsfw', 'canceled'])

export type MediaUrl = { url: string }

export type QueuedRequest = {
  status: RequestStatus
  request_id: string
  status_url: string
  cancel_url: string
  /** Seconds the request data is retained after it finishes. */
  expires_after?: number
}

export type RequestResult = {
  status: RequestStatus
  request_id: string
  expires_at?: string
  error?: unknown
  images?: MediaUrl[]
  video?: MediaUrl
}

export class HiggsfieldError extends Error {
  constructor(
    message: string,
    readonly httpStatus?: number,
    readonly body?: unknown,
    readonly result?: RequestResult
  ) {
    super(message)
    this.name = 'HiggsfieldError'
  }
}

// Accepts HF_CREDENTIALS="KEY_ID:KEY_SECRET" or the documented HF_API_KEY_ID / HF_API_KEY_SECRET pair.
const authHeader = () => {
  const { HF_CREDENTIALS, HF_API_KEY_ID, HF_API_KEY_SECRET } = process.env
  const credentials =
    HF_CREDENTIALS ?? (HF_API_KEY_ID && HF_API_KEY_SECRET ? `${HF_API_KEY_ID}:${HF_API_KEY_SECRET}` : undefined)
  if (!credentials) {
    throw new HiggsfieldError('Missing Higgsfield credentials: set HF_CREDENTIALS="KEY_ID:KEY_SECRET"')
  }
  return `Key ${credentials}`
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isRetryable = (error: unknown) =>
  !(error instanceof HiggsfieldError) ||
  error.httpStatus === undefined ||
  error.httpStatus === 429 ||
  error.httpStatus >= 500

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: authHeader(), 'Content-Type': 'application/json', ...init.headers }
  })
  const text = await res.text()
  let body: unknown = undefined
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  if (!res.ok) {
    throw new HiggsfieldError(`Higgsfield ${init.method ?? 'GET'} ${path} failed with ${res.status}`, res.status, body)
  }
  return body as T
}

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
export async function submit(
  endpoint: string,
  input: object,
  { idempotencyKey = crypto.randomUUID(), webhookUrl, maxRetries = 3, retryDelay = 1000 }: SubmitOptions = {}
): Promise<QueuedRequest> {
  const query = webhookUrl ? `?hf_webhook=${encodeURIComponent(webhookUrl)}` : ''
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<QueuedRequest>(`/${endpoint}${query}`, {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(input)
      })
    } catch (error) {
      if (attempt >= maxRetries || !isRetryable(error)) throw error
      await sleep(Math.min(retryDelay * 2 ** attempt, 30_000))
    }
  }
}

export const getStatus = (requestId: string) => request<RequestResult>(`/requests/${requestId}/status`)

/** Only queued requests can be canceled; throws (400) once processing has started. */
export const cancel = (requestId: string) => request<void>(`/requests/${requestId}/cancel`, { method: 'POST' })

export type WaitOptions = {
  pollInterval?: number
  maxPollInterval?: number
  timeout?: number
  signal?: AbortSignal
  onStatus?: (result: RequestResult) => void
}

/** Poll with backoff until the request reaches a terminal status. */
export async function waitFor(
  requestId: string,
  { pollInterval = 2000, maxPollInterval = 15_000, timeout = 5 * 60_000, signal, onStatus }: WaitOptions = {}
): Promise<RequestResult> {
  const deadline = Date.now() + timeout
  let interval = pollInterval
  while (true) {
    signal?.throwIfAborted()
    try {
      const result = await getStatus(requestId)
      onStatus?.(result)
      if (TERMINAL.has(result.status)) return result
    } catch (error) {
      if (!isRetryable(error)) throw error
    }
    if (Date.now() + interval > deadline) {
      throw new HiggsfieldError(`Request ${requestId} did not finish within ${timeout}ms`)
    }
    await sleep(interval)
    interval = Math.min(interval * 1.5, maxPollInterval)
  }
}

export type RunOptions = SubmitOptions & WaitOptions

/** Submit, wait, and throw unless the request completed. */
export async function run(endpoint: string, input: object, options: RunOptions = {}): Promise<RequestResult> {
  const { request_id } = await submit(endpoint, input, options)
  const result = await waitFor(request_id, options)
  if (result.status !== 'completed') {
    throw new HiggsfieldError(`Request ${request_id} ended with status "${result.status}"`, undefined, result.error, result)
  }
  return result
}
