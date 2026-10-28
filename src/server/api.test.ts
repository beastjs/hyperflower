import { expect, test } from 'bun:test'
import { ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Schema } from 'effect'
import { buildRequest, type Settings } from '../lib/generate'
import { apiMiddleware, GenerateRequest } from './api'

const decode = Schema.decodeUnknownExit(GenerateRequest)

const settings: Settings = {
  mode: 'image',
  prompt: 'a lake at dawn',
  imageModel: 'fluxSchnell',
  videoModel: 'seedanceFast',
  aspect: '16:9',
  resolution: '720p',
  duration: 5,
  imageUrl: '',
  references: [],
  steps: 20,
  model3d: 'hitem3d',
  resolution3d: '1536',
  texture: true,
  format3d: 'glb'
}

test.each([
  { imageModel: 'fluxSchnell' },
  { imageModel: 'flux2Klein' },
  { imageModel: 'flux2Dev' },
  { imageModel: 'seedream5Pro' },
  { imageModel: 'soulv2' },
  { mode: 'video', videoModel: 'seedanceFast' },
  { mode: 'video', videoModel: 'seedanceText' },
  { mode: 'video', videoModel: 'wanReference', imageUrl: 'https://img/a.png' },
  { mode: '3d', references: ['data:image/png;base64,AAAA', 'https://img/back.png'] }
] as Partial<Settings>[])('accepts what the UI builds for %o', (overrides) => {
  const request = buildRequest({ ...settings, ...overrides })
  expect(typeof request).toBe('object')
  expect(decode(request)._tag).toBe('Success')
})

test('a 3D request needs 1-4 views and a views bitmap that matches them', () => {
  const request = (input: object) => ({ kind: '3d', model: 'hitem3d', input })
  expect(buildRequest({ ...settings, mode: '3d' })).toBe('Add 1–4 photos of the object: front, back, left, right.')
  expect(decode(request({ images: [] }))._tag).toBe('Failure')
  expect(decode(request({ images: Array(5).fill('https://img/a.png') }))._tag).toBe('Failure')
  expect(decode(request({ images: ['a', 'b'], views: '1010' }))._tag).toBe('Success')
  expect(decode(request({ images: ['a', 'b'], views: '1000' }))._tag).toBe('Failure')
  expect(decode(request({ images: ['a'], face: 50 }))._tag).toBe('Failure')
})

test('rejects an unknown model, a kind mismatch, and invalid input', () => {
  expect(decode({ kind: 'image', model: 'nope', input: { prompt: 'p' } })._tag).toBe('Failure')
  expect(decode({ kind: 'video', model: 'fluxSchnell', input: { prompt: 'p' } })._tag).toBe('Failure')
  expect(decode({ kind: 'image', model: 'fluxSchnell', input: { prompt: 'p', steps: 50 } })._tag).toBe('Failure')
  expect(decode({ kind: 'video', model: 'seedanceFast', input: { duration: 5 } })._tag).toBe('Failure')
})

test('strips unknown fields instead of forwarding them to providers', () => {
  const exit = decode({ kind: 'image', model: 'fluxSchnell', input: { prompt: 'p', extra: 1 }, other: true })
  expect(exit).toMatchObject({ _tag: 'Success', value: { kind: 'image', model: 'fluxSchnell', input: { prompt: 'p' } } })
})

test('answers bad requests with a short message', async () => {
  const send = async (body: string) => {
    const req = Object.assign(Readable.from([body]), { method: 'POST', url: '/api/generate' })
    const res = new ServerResponse(req as never)
    let out = ''
    res.end = ((chunk: string) => ((out = chunk), res)) as never
    await apiMiddleware(req as never, res, () => {})
    return [res.statusCode, JSON.parse(out).error]
  }
  expect(await send('not json')).toEqual([400, 'Expected a valid JSON string'])
  expect(await send('{"kind":"image","model":"nope","input":{}}')).toEqual([400, 'Unknown image model\n  at ["model"]'])
  expect(await send('{"kind":"video","model":"fluxSchnell","input":{}}')).toEqual([400, 'Unknown video model\n  at ["model"]'])
  expect(await send('{"kind":"audio"}')).toEqual([400, 'kind must be "image", "video" or "3d"'])
  expect(await send('{"kind":"image","model":"fluxSchnell","input":{"prompt":"p","steps":50}}')).toEqual([
    400,
    'Expected a value between 1 and 8\n  at ["input"]["steps"]'
  ])
})

test('relays generated files from Ark storage only', async () => {
  const get = async (target: string, upstream?: Response) => {
    const originalFetch = globalThis.fetch
    const fetched: string[] = []
    globalThis.fetch = (async (url: URL) => (fetched.push(String(url)), upstream ?? new Response(null, { status: 500 }))) as never
    const req = Object.assign(Readable.from([]), { method: 'GET', url: `/api/files?url=${encodeURIComponent(target)}` })
    const res = new ServerResponse(req as never)
    const chunks: Buffer[] = []
    res.write = ((chunk: Buffer) => (chunks.push(Buffer.from(chunk)), true)) as never
    res.end = ((chunk?: string | Buffer) => (chunk && chunks.push(Buffer.from(chunk)), res.emit('finish'), res)) as never
    try {
      await apiMiddleware(req as never, res, () => {})
    } finally {
      globalThis.fetch = originalFetch
    }
    return { status: res.statusCode, body: Buffer.concat(chunks).toString(), fetched }
  }
  const file = 'https://ark-common-storage-prod-ap-southeast-1.tos-ap-southeast-1.volces.com/m.glb?X-Tos-Expires=604800'

  const ok = await get(file, new Response('glTF', { headers: { 'content-type': 'binary/octet-stream' } }))
  expect(ok).toEqual({ status: 200, body: 'glTF', fetched: [file] })

  const expired = await get(file, new Response(null, { status: 403 }))
  expect([expired.status, JSON.parse(expired.body).error]).toEqual([410, 'This file has expired'])

  for (const target of ['https://example.com/m.glb', 'http://x.volces.com/m.glb', 'https://volces.com.evil.io/m.glb', 'nope']) {
    const rejected = await get(target)
    expect([rejected.status, rejected.fetched]).toEqual([400, []])
  }
})
