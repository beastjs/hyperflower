import { afterEach, beforeEach, expect, test } from 'bun:test'
import { CloudflareAIError, generateCloudflareImage } from '.'

type Call = { url: string; init: RequestInit }

const originalFetch = globalThis.fetch
const originalEnv = { id: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_API_TOKEN }
let calls: Call[]
let reply: { status?: number; body?: unknown }

beforeEach(() => {
  calls = []
  reply = {}
  process.env.CLOUDFLARE_ACCOUNT_ID = 'acct'
  process.env.CLOUDFLARE_API_TOKEN = 'token'
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  const restore = (key: string, value?: string) => (value === undefined ? delete process.env[key] : (process.env[key] = value))
  restore('CLOUDFLARE_ACCOUNT_ID', originalEnv.id)
  restore('CLOUDFLARE_API_TOKEN', originalEnv.token)
})

test('posts the input to the account model endpoint and returns a data URL', async () => {
  reply = { body: { success: true, result: { image: '/9j/abc' } } }
  const url = await generateCloudflareImage('fluxSchnell', { prompt: 'lake', steps: 4 })

  expect(url).toBe('data:image/jpeg;base64,/9j/abc')
  expect(calls[0].url).toBe(
    'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/black-forest-labs/flux-1-schnell'
  )
  expect(calls[0].init.method).toBe('POST')
  expect(new Headers(calls[0].init.headers).get('authorization')).toBe('Bearer token')
  expect(JSON.parse(String(calls[0].init.body))).toEqual({ prompt: 'lake', steps: 4 })
})

test('detects PNG output', async () => {
  reply = { body: { success: true, result: { image: 'iVBORw0' } } }
  expect(await generateCloudflareImage('fluxSchnell', { prompt: 'p' })).toStartWith('data:image/png;base64,')
})

test('surfaces Cloudflare error messages with the status', async () => {
  reply = { status: 429, body: { success: false, errors: [{ code: 3036, message: 'Daily free allocation exceeded' }] } }
  const error = await generateCloudflareImage('fluxSchnell', { prompt: 'p' }).catch((e) => e)

  expect(error).toBeInstanceOf(CloudflareAIError)
  expect(error.httpStatus).toBe(429)
  expect(error.message).toBe('Cloudflare fluxSchnell failed with 429: Daily free allocation exceeded')
})

test('treats a success response without an image as a failure', async () => {
  reply = { body: { success: true, result: {} } }
  await expect(generateCloudflareImage('fluxSchnell', { prompt: 'p' })).rejects.toBeInstanceOf(CloudflareAIError)
})

test('throws before any request when credentials are missing', async () => {
  delete process.env.CLOUDFLARE_API_TOKEN
  await expect(generateCloudflareImage('fluxSchnell', { prompt: 'p' })).rejects.toThrow('CLOUDFLARE_API_TOKEN')
  expect(calls).toHaveLength(0)
})
