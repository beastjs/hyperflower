import { afterEach, beforeEach, expect, test } from 'bun:test'
import { runPromise } from '../runtime'
import { ArkError, generateArk3D, generateArkImage, generateArkVideo } from '.'

type Call = { url: string; method: string; headers: Headers; body?: unknown }

const BASE = 'https://ark.ap-southeast.bytepluses.com/api/v3'
const originalFetch = globalThis.fetch
const originalKey = process.env.ARK_API_KEY
let calls: Call[]
let replies: { status?: number; body?: unknown }[]

beforeEach(() => {
  calls = []
  replies = []
  process.env.ARK_API_KEY = 'ark-key'
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) : undefined
    calls.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers), body })
    const reply = replies.shift() ?? { status: 500 }
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 })
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalKey === undefined) delete process.env.ARK_API_KEY
  else process.env.ARK_API_KEY = originalKey
})

test('generates an image and returns its url', async () => {
  replies.push({ body: { data: [{ url: 'https://cdn/a.png' }] } })
  const url = await runPromise(generateArkImage({ model: 'seedream5Flash', input: { prompt: 'lake', size: '2K' } }))

  expect(url).toBe('https://cdn/a.png')
  expect(calls[0].url).toBe(`${BASE}/images/generations`)
  expect(calls[0].headers.get('authorization')).toBe('Bearer ark-key')
  expect(calls[0].body).toEqual({
    model: 'dola-seedream-5-0-flash-260915',
    watermark: false,
    prompt: 'lake',
    size: '2K',
    response_format: 'url'
  })
})

test('surfaces the provider error message and status', async () => {
  replies.push({ status: 400, body: { error: { message: 'prompt rejected' } } })
  const error = await runPromise(generateArkImage({ model: 'seedream5Pro', input: { prompt: 'p' } })).catch((e) => e)

  expect(error).toBeInstanceOf(ArkError)
  expect(error.message).toBe('Ark seedream5Pro failed with 400: prompt rejected')
  expect(error.httpStatus).toBe(400)
})

test('fails before any request without credentials', async () => {
  delete process.env.ARK_API_KEY
  await expect(runPromise(generateArkImage({ model: 'seedream5Pro', input: { prompt: 'p' } }))).rejects.toThrow(
    'Missing BytePlus credentials'
  )
  expect(calls).toHaveLength(0)
})

test('polls a video task until it succeeds', async () => {
  replies.push(
    { body: { id: 'task-1' } },
    { body: { status: 'running' } },
    { body: { status: 'succeeded', content: { video_url: 'https://cdn/v.mp4' } } }
  )
  const video = await runPromise(
    generateArkVideo({ model: 'seedanceFast', input: { prompt: 'waves', image_url: 'https://img/a.png' } }, { interval: 1 })
  )

  expect(video).toBe('https://cdn/v.mp4')
  expect(calls.map((call) => call.method)).toEqual(['POST', 'GET', 'GET'])
  expect(calls[1].url).toBe(`${BASE}/contents/generations/tasks/task-1`)
  expect(calls[0].body).toMatchObject({ ratio: 'adaptive', watermark: false })
})

test('fails when the video task fails or times out', async () => {
  replies.push({ body: { id: 't' } }, { body: { status: 'failed', error: { message: 'nsfw' } } })
  await expect(
    runPromise(generateArkVideo({ model: 'seedanceFast', input: { prompt: 'p' } }, { interval: 1 }))
  ).rejects.toThrow('Ark seedanceFast task failed: nsfw')

  replies.push({ body: { id: 't' } }, ...Array(50).fill({ body: { status: 'queued' } }))
  await expect(
    runPromise(generateArkVideo({ model: 'seedanceFast', input: { prompt: 'p' } }, { interval: 1, timeout: 20 }))
  ).rejects.toThrow('timed out')
})

test('generates a 3D model, passing options as flags and images in view order', async () => {
  replies.push(
    { body: { id: '3d-1' } },
    { body: { status: 'running' } },
    { body: { status: 'succeeded', content: { file_url: 'https://cdn/model.glb' } } }
  )
  const model = await runPromise(
    generateArk3D(
      { model: 'hitem3d', input: { images: ['data:image/png;base64,AAAA', 'https://img/back.png'], resolution: '1536pro' } },
      { interval: 1 }
    )
  )

  expect(model).toEqual({ url: 'https://cdn/model.glb', format: 'glb' })
  expect(calls[0].url).toBe(`${BASE}/contents/generations/tasks`)
  expect(calls[0].body).toEqual({
    model: 'hitem3d-2-0-251223',
    content: [
      { type: 'text', text: '--resolution 1536pro --request_type 3 --fileformat 2 --multi_images_bit 1100' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'image_url', image_url: { url: 'https://img/back.png' } }
    ]
  })
})

test('reads a 3D file url given as { url } and honours geometry-only and other formats', async () => {
  replies.push({ body: { id: '3d-2' } }, { body: { status: 'succeeded', content: { file_url: { url: 'https://cdn/m.obj' } } } })
  const model = await runPromise(
    generateArk3D(
      { model: 'hitem3d', input: { images: ['https://img/a.png'], texture: false, format: 'obj', face: 200_000 } },
      { interval: 1 }
    )
  )

  expect(model).toEqual({ url: 'https://cdn/m.obj', format: 'obj' })
  expect(calls[0].body).toMatchObject({ content: [{ text: '--request_type 1 --fileformat 1 --face 200000' }, {}] })
})

test('cancels the Ark task when the caller is interrupted', async () => {
  replies.push({ body: { id: '3d-3' } }, ...Array(20).fill({ body: { status: 'running' } }))
  const controller = new AbortController()
  const running = runPromise(generateArk3D({ model: 'hitem3d', input: { images: ['https://img/a.png'] } }, { interval: 1 }), {
    signal: controller.signal
  })
  await Bun.sleep(10)
  controller.abort()
  await expect(running).rejects.toThrow()

  const last = calls.at(-1)
  expect(last?.method).toBe('DELETE')
  expect(last?.url).toBe(`${BASE}/contents/generations/tasks/3d-3`)
})
