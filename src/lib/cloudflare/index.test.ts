import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { runPromise } from '../runtime'
import * as cloudflare from '.'
import { CloudflareAIError, FLUX2_DEV_DEFAULT_STEPS, estimateNeurons } from '.'

const generateCloudflareImage = (request: cloudflare.CloudflareRequest) => runPromise(cloudflare.generateCloudflareImage(request))
const fetchNeuronsUsedToday = () => runPromise(cloudflare.fetchNeuronsUsedToday())
// HttpClient sends JSON bodies as bytes rather than strings.
const jsonBody = (body: unknown) => JSON.parse(typeof body === 'string' ? body : new TextDecoder().decode(body as Uint8Array))

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
    calls.push({ url: String(url), init })
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  const restore = (key: string, value?: string) => (value === undefined ? delete process.env[key] : (process.env[key] = value))
  restore('CLOUDFLARE_ACCOUNT_ID', originalEnv.id)
  restore('CLOUDFLARE_API_TOKEN', originalEnv.token)
})

const RUN = 'https://api.cloudflare.com/client/v4/accounts/acct/ai/run'
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgo='

describe('fluxSchnell', () => {
  test('posts JSON to the account model endpoint and returns a data URL with its cost', async () => {
    reply = { body: { success: true, result: { image: '/9j/abc' } } }
    const result = await generateCloudflareImage({ model: 'fluxSchnell', input: { prompt: 'lake', steps: 4 } })

    expect(result).toEqual({ image: 'data:image/jpeg;base64,/9j/abc', neurons: 57.6 })
    expect(calls[0].url).toBe(`${RUN}/@cf/black-forest-labs/flux-1-schnell`)
    expect(calls[0].init.method).toBe('POST')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('authorization')).toBe('Bearer token')
    expect(headers.get('content-type')).toBe('application/json')
    expect(jsonBody(calls[0].init.body)).toEqual({ prompt: 'lake', steps: 4 })
  })

  test('detects PNG output', async () => {
    reply = { body: { success: true, result: { image: 'iVBORw0' } } }
    const { image } = await generateCloudflareImage({ model: 'fluxSchnell', input: { prompt: 'p' } })
    expect(image).toStartWith('data:image/png;base64,')
  })
})

describe('flux2Klein', () => {
  test('sends multipart form fields and references as input_image_N', async () => {
    reply = { body: { success: true, result: { image: '/9j/xyz' } } }
    await generateCloudflareImage({
      model: 'flux2Klein',
      input: { prompt: 'style image 1 like image 2', width: 768, height: 1024, reference_images: [PNG_1PX, PNG_1PX] }
    })

    expect(calls[0].url).toBe(`${RUN}/@cf/black-forest-labs/flux-2-klein-4b`)
    // fetch must set the multipart boundary itself.
    expect(new Headers(calls[0].init.headers).get('content-type')).toBeNull()
    const form = calls[0].init.body as FormData
    expect(form.get('prompt')).toBe('style image 1 like image 2')
    expect(form.get('width')).toBe('768')
    expect(form.get('height')).toBe('1024')
    expect(form.get('reference_images')).toBeNull()
    const ref = form.get('input_image_1') as Blob
    expect(ref.type).toBe('image/png')
    expect(ref.size).toBeGreaterThan(0)
  })

  test('rejects non-data-URL references and more than four of them before calling Cloudflare', async () => {
    await expect(
      generateCloudflareImage({ model: 'flux2Klein', input: { prompt: 'p', reference_images: ['https://x/a.png'] } })
    ).rejects.toThrow('data URLs')
    await expect(
      generateCloudflareImage({ model: 'flux2Klein', input: { prompt: 'p', reference_images: Array(5).fill(PNG_1PX) } })
    ).rejects.toThrow('At most 4')
    expect(calls).toHaveLength(0)
  })
})

describe('flux2Dev', () => {
  test('sends multipart with an explicit step count and prices per step', async () => {
    reply = { body: { success: true, result: { image: '/9j/dev' } } }
    const { neurons } = await generateCloudflareImage({
      model: 'flux2Dev',
      input: { prompt: 'p', width: 1024, height: 1024, reference_images: [PNG_1PX] }
    })

    expect(calls[0].url).toBe(`${RUN}/@cf/black-forest-labs/flux-2-dev`)
    const form = calls[0].init.body as FormData
    expect(form.get('steps')).toBe(String(FLUX2_DEV_DEFAULT_STEPS))
    expect(form.get('input_image_0')).toBeInstanceOf(Blob)
    // 20 steps × (1 ref tile × 18.75 + 4 output tiles × 37.5)
    expect(neurons).toBe(3375)
  })

  test('keeps a caller-chosen step count', async () => {
    reply = { body: { success: true, result: { image: '/9j/dev' } } }
    const { neurons } = await generateCloudflareImage({ model: 'flux2Dev', input: { prompt: 'p', steps: 8, width: 512, height: 512 } })
    expect((calls[0].init.body as FormData).get('steps')).toBe('8')
    expect(neurons).toBe(300)
  })
})

describe('estimateNeurons', () => {
  test('schnell: four 512px tiles plus 9.6 per step', () => {
    expect(estimateNeurons({ model: 'fluxSchnell', input: {} })).toBe(57.6)
    expect(estimateNeurons({ model: 'fluxSchnell', input: { steps: 8 } })).toBe(96)
  })

  test('klein: 26.05 per output tile plus 5.37 per reference', () => {
    expect(estimateNeurons({ model: 'flux2Klein', input: { width: 1024, height: 1024 } })).toBe(104.2)
    // Defaults are 1024×768 → 2×2 tiles.
    expect(estimateNeurons({ model: 'flux2Klein', input: {} })).toBe(104.2)
    expect(estimateNeurons({ model: 'flux2Klein', input: { width: 512, height: 512, reference_images: ['a', 'b'] } })).toBe(
      36.79
    )
  })

  test('dev: per step, 37.5 per output tile plus 18.75 per reference', () => {
    expect(estimateNeurons({ model: 'flux2Dev', input: { width: 1024, height: 1024, steps: 10 } })).toBe(1500)
    expect(estimateNeurons({ model: 'flux2Dev', input: {} })).toBe(FLUX2_DEV_DEFAULT_STEPS * 150)
  })
})

describe('errors', () => {
  test('surfaces Cloudflare error messages with the status', async () => {
    reply = { status: 429, body: { success: false, errors: [{ code: 3036, message: 'Daily free allocation exceeded' }] } }
    const error = await generateCloudflareImage({ model: 'fluxSchnell', input: { prompt: 'p' } }).catch((e) => e)

    expect(error).toBeInstanceOf(CloudflareAIError)
    expect(error.httpStatus).toBe(429)
    expect(error.message).toBe('Cloudflare fluxSchnell failed with 429: Daily free allocation exceeded')
  })

  test('treats a success response without an image as a failure', async () => {
    reply = { body: { success: true, result: {} } }
    await expect(generateCloudflareImage({ model: 'fluxSchnell', input: { prompt: 'p' } })).rejects.toBeInstanceOf(
      CloudflareAIError
    )
  })

  test('throws before any request when credentials are missing', async () => {
    delete process.env.CLOUDFLARE_API_TOKEN
    await expect(generateCloudflareImage({ model: 'fluxSchnell', input: { prompt: 'p' } })).rejects.toThrow(
      'CLOUDFLARE_API_TOKEN'
    )
    expect(calls).toHaveLength(0)
  })
})

describe('fetchNeuronsUsedToday', () => {
  test("sums today's neuron groups for the account", async () => {
    reply = {
      body: {
        data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 57.6 } }, { sum: { totalNeurons: 104.2 } }] }] } },
        errors: null
      }
    }
    expect(await fetchNeuronsUsedToday()).toBeCloseTo(161.8)

    const body = jsonBody(calls[0].init.body)
    expect(calls[0].url).toBe('https://api.cloudflare.com/client/v4/graphql')
    expect(body.variables).toEqual({ account: 'acct', date: new Date().toISOString().slice(0, 10) })
  })

  test('throws when the token lacks analytics access', async () => {
    reply = { body: { data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: null }] } }, errors: [{ message: 'not authorized for that account' }] } }
    await expect(fetchNeuronsUsedToday()).rejects.toThrow('not authorized for that account')
  })
})
