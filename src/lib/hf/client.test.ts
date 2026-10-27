import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { cancel, getStatus, HiggsfieldError, run, submit, waitFor } from './client'
import { mockHiggsfield, queued, status } from './test-helpers'

const BASE = 'https://api.higgsfield.ai'
const fast = { pollInterval: 1, maxPollInterval: 1 }

let hf: ReturnType<typeof mockHiggsfield>

beforeEach(() => {
  hf = mockHiggsfield()
})

afterEach(() => {
  hf.restore()
})

describe('auth', () => {
  test('sends HF_CREDENTIALS as a Key header', async () => {
    hf.reply(status('r1', 'queued'))
    await getStatus('r1')
    expect(hf.calls[0].headers.authorization).toBe('Key key-id:key-secret')
  })

  test('falls back to HF_API_KEY_ID / HF_API_KEY_SECRET', async () => {
    delete process.env.HF_CREDENTIALS
    process.env.HF_API_KEY_ID = 'id'
    process.env.HF_API_KEY_SECRET = 'secret'
    hf.reply(status('r1', 'queued'))
    await getStatus('r1')
    expect(hf.calls[0].headers.authorization).toBe('Key id:secret')
  })

  test('throws before any request when credentials are missing', async () => {
    delete process.env.HF_CREDENTIALS
    await expect(getStatus('r1')).rejects.toThrow('Missing Higgsfield credentials')
    expect(hf.calls).toHaveLength(0)
  })
})

describe('submit', () => {
  test('posts the input with an idempotency key and returns the queued request', async () => {
    hf.reply(queued('r1'))
    const res = await submit('higgsfield-ai/soul/v2/standard', { prompt: 'lake' })

    expect(res.request_id).toBe('r1')
    expect(hf.calls).toHaveLength(1)
    const [call] = hf.calls
    expect(call.url).toBe(`${BASE}/higgsfield-ai/soul/v2/standard`)
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({ prompt: 'lake' })
    expect(call.headers['content-type']).toBe('application/json')
    expect(call.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('uses a caller-provided idempotency key and webhook url', async () => {
    hf.reply(queued('r1'))
    await submit('m', {}, { idempotencyKey: 'abc', webhookUrl: 'https://x.dev/hook?a=1' })

    expect(hf.calls[0].headers['idempotency-key']).toBe('abc')
    expect(hf.calls[0].url).toBe(`${BASE}/m?hf_webhook=${encodeURIComponent('https://x.dev/hook?a=1')}`)
  })

  test('keeps the webhook query out of error messages', async () => {
    hf.reply({ status: 403, body: { detail: 'Not enough credits' } })
    const error = await submit('m', {}, { webhookUrl: 'https://x.dev/hook' }).catch((e) => e)
    expect(error.message).toBe('Higgsfield POST /m failed with 403: Not enough credits')
  })

  test('retries 5xx, 429 and network errors with the same idempotency key', async () => {
    hf.reply({ status: 503 }, { status: 429 }, new TypeError('fetch failed'), queued('r1'))
    const res = await submit('m', {}, { retryDelay: 1 })

    expect(res.request_id).toBe('r1')
    expect(hf.calls).toHaveLength(4)
    const keys = new Set(hf.calls.map((call) => call.headers['idempotency-key']))
    expect(keys.size).toBe(1)
  })

  test('does not retry client errors', async () => {
    hf.reply({ status: 422, body: { detail: 'bad prompt' } })
    const error = await submit('m', {}, { retryDelay: 1 }).catch((e) => e)

    expect(error).toBeInstanceOf(HiggsfieldError)
    expect(error.message).toBe('Higgsfield POST /m failed with 422: bad prompt')
    expect(error.httpStatus).toBe(422)
    expect(error.body).toEqual({ detail: 'bad prompt' })
    expect(hf.calls).toHaveLength(1)
  })

  test('gives up after maxRetries', async () => {
    hf.always({ status: 500 })
    await expect(submit('m', {}, { maxRetries: 2, retryDelay: 1 })).rejects.toThrow('failed with 500')
    expect(hf.calls).toHaveLength(3)
  })

  test('keeps a non-JSON error body as text', async () => {
    hf.reply({ status: 400, raw: 'Bad Request' })
    const error = await submit('m', {}).catch((e) => e)
    expect(error.body).toBe('Bad Request')
  })
})

describe('cancel', () => {
  test('posts to the cancel endpoint and accepts an empty 202', async () => {
    hf.reply({ status: 202 })
    await expect(cancel('r1')).resolves.toBeUndefined()
    expect(hf.calls[0]).toMatchObject({ url: `${BASE}/requests/r1/cancel`, method: 'POST' })
  })

  test('throws once processing has started', async () => {
    hf.reply({ status: 400 })
    await expect(cancel('r1')).rejects.toBeInstanceOf(HiggsfieldError)
  })
})

describe('waitFor', () => {
  test('polls the status endpoint until completed', async () => {
    hf.reply(status('r1', 'queued'), status('r1', 'in_progress'), status('r1', 'completed', { images: [{ url: 'u' }] }))
    const seen: string[] = []
    const result = await waitFor('r1', { ...fast, onStatus: (r) => seen.push(r.status) })

    expect(result.images).toEqual([{ url: 'u' }])
    expect(seen).toEqual(['queued', 'in_progress', 'completed'])
    expect(hf.calls.every((call) => call.url === `${BASE}/requests/r1/status`)).toBe(true)
  })

  test.each(['failed', 'nsfw', 'canceled'])('stops on terminal status %s', async (value) => {
    hf.reply(status('r1', value))
    const result = await waitFor('r1', fast)
    expect(result.status).toBe(value as never)
    expect(hf.calls).toHaveLength(1)
  })

  test('keeps polling through server errors', async () => {
    hf.reply({ status: 502 }, new TypeError('fetch failed'), status('r1', 'completed'))
    const result = await waitFor('r1', fast)
    expect(result.status).toBe('completed')
    expect(hf.calls).toHaveLength(3)
  })

  test('throws on client errors', async () => {
    hf.reply({ status: 404 })
    await expect(waitFor('r1', fast)).rejects.toMatchObject({ httpStatus: 404 })
  })

  test('throws when the timeout is exceeded', async () => {
    hf.always(status('r1', 'in_progress'))
    await expect(waitFor('r1', { pollInterval: 5, maxPollInterval: 5, timeout: 20 })).rejects.toThrow(
      'did not finish within 20ms'
    )
  })

  test('stops when the signal is aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(waitFor('r1', { signal: controller.signal })).rejects.toThrow()
    expect(hf.calls).toHaveLength(0)
  })
})

describe('run', () => {
  test('submits then returns the completed result', async () => {
    hf.reply(queued('r1'), status('r1', 'completed', { video: { url: 'v' } }))
    const result = await run('m', { prompt: 'p' }, fast)

    expect(result.video).toEqual({ url: 'v' })
    expect(hf.calls.map((call) => call.method)).toEqual(['POST', 'GET'])
  })

  test.each(['failed', 'nsfw', 'canceled'])('throws with the result when the request ends %s', async (value) => {
    hf.reply(queued('r1'), status('r1', value, { error: 'boom' }))
    const error = await run('m', {}, fast).catch((e) => e)

    expect(error).toBeInstanceOf(HiggsfieldError)
    expect(error.message).toContain(`"${value}"`)
    expect(error.body).toBe('boom')
    expect(error.result.status).toBe(value)
  })
})
