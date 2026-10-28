// Shared fetch/env stubs for the hf tests.

type Reply = { status?: number; body?: unknown; raw?: string } | Error

export type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
}

// HttpClient sends JSON bodies as bytes rather than strings.
const bodyText = (body: BodyInit) => (typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array))

const ENV_KEYS = ['HF_CREDENTIALS', 'HF_API_KEY_ID', 'HF_API_KEY_SECRET'] as const

export const mockHiggsfield = () => {
  const calls: FetchCall[] = []
  const replies: Reply[] = []
  let fallback: Reply | undefined
  const originalFetch = globalThis.fetch
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))

  for (const key of ENV_KEYS) delete process.env[key]
  process.env.HF_CREDENTIALS = 'key-id:key-secret'

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(bodyText(init.body)) : undefined
    })
    const reply = replies.shift() ?? fallback
    if (!reply) throw new Error(`Unexpected fetch: ${input}`)
    if (reply instanceof Error) throw reply
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body))
    return new Response(text, { status: reply.status ?? 200 })
  }) as unknown as typeof fetch

  return {
    calls,
    /** Queue one reply per fetch, in order. */
    reply: (...next: Reply[]) => replies.push(...next),
    /** Reply used once the queue is empty. */
    always: (reply: Reply) => (fallback = reply),
    restore: () => {
      globalThis.fetch = originalFetch
      for (const key of ENV_KEYS) {
        if (originalEnv[key] === undefined) delete process.env[key]
        else process.env[key] = originalEnv[key]
      }
    }
  }
}

export const queued = (id: string) => ({
  body: {
    status: 'queued',
    request_id: id,
    status_url: `https://api.higgsfield.ai/requests/${id}/status`,
    cancel_url: `https://api.higgsfield.ai/requests/${id}/cancel`
  }
})

export const status = (id: string, value: string, extra: object = {}) => ({
  body: { status: value, request_id: id, ...extra }
})
