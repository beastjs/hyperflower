import { afterEach, beforeEach, expect, test } from 'bun:test'
import { generateImage, imageModels, queueImage, type ImageModel } from './image'
import { HiggsfieldError } from './client'
import { mockHiggsfield, queued, status } from './test-helpers'

const BASE = 'https://api.higgsfield.ai'

let hf: ReturnType<typeof mockHiggsfield>

beforeEach(() => {
  hf = mockHiggsfield()
})

afterEach(() => {
  hf.restore()
})

test.each(Object.entries(imageModels))('%s submits to %s', async (model, endpoint) => {
  hf.reply(queued('r1'), status('r1', 'completed', { images: [{ url: 'a' }, { url: 'b' }] }))
  const result = await generateImage(model as ImageModel, { prompt: 'lake', aspect_ratio: '9:16' })

  expect(result).toEqual({ requestId: 'r1', images: ['a', 'b'] })
  expect(hf.calls[0].url).toBe(`${BASE}/${endpoint}`)
  expect(hf.calls[0].body).toEqual({ prompt: 'lake', aspect_ratio: '9:16' })
})

test('model ids match the documented endpoints', () => {
  expect(imageModels).toEqual({
    soul: 'higgsfield-ai/soul/standard',
    soulv2: 'higgsfield-ai/soul/v2/standard',
    soulcinema: 'higgsfield-ai/soul/cinema'
  })
})

test('throws when a completed request has no images', async () => {
  hf.reply(queued('r1'), status('r1', 'completed', { images: [] }))
  const error = await generateImage('soul', { prompt: 'p' }).catch((e) => e)

  expect(error).toBeInstanceOf(HiggsfieldError)
  expect(error.message).toContain('without images')
})

test('throws when the request is flagged nsfw', async () => {
  hf.reply(queued('r1'), status('r1', 'nsfw'))
  await expect(generateImage('soulv2', { prompt: 'p' })).rejects.toThrow('"nsfw"')
})

test('queueImage submits without polling', async () => {
  hf.reply(queued('r1'))
  const res = await queueImage('soulcinema', { prompt: 'p' }, { idempotencyKey: 'k' })

  expect(res.request_id).toBe('r1')
  expect(hf.calls).toHaveLength(1)
  expect(hf.calls[0].headers['idempotency-key']).toBe('k')
})
