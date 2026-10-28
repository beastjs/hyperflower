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
  steps: 20
}

test.each([
  { imageModel: 'fluxSchnell' },
  { imageModel: 'flux2Klein' },
  { imageModel: 'flux2Dev' },
  { imageModel: 'seedream5Pro' },
  { imageModel: 'soulv2' },
  { mode: 'video', videoModel: 'seedanceFast' },
  { mode: 'video', videoModel: 'seedanceText' },
  { mode: 'video', videoModel: 'wanReference', imageUrl: 'https://img/a.png' }
] as Partial<Settings>[])('accepts what the UI builds for %o', (overrides) => {
  const request = buildRequest({ ...settings, ...overrides })
  expect(typeof request).toBe('object')
  expect(decode(request)._tag).toBe('Success')
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
  expect(await send('{"kind":"audio"}')).toEqual([400, 'kind must be "image" or "video"'])
  expect(await send('{"kind":"image","model":"fluxSchnell","input":{"prompt":"p","steps":50}}')).toEqual([
    400,
    'Expected a value between 1 and 8\n  at ["input"]["steps"]'
  ])
})
