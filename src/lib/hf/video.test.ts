import { afterEach, beforeEach, expect, test } from 'bun:test'
import { runPromise } from '../runtime'
import * as video from './video'
import { videoModels } from './video'
import { HiggsfieldError } from './client'
import { mockHiggsfield, queued, status } from './test-helpers'

const generateVideo = (...args: Parameters<typeof video.generateVideo>) => runPromise(video.generateVideo(...args))
const queueVideo = (...args: Parameters<typeof video.queueVideo>) => runPromise(video.queueVideo(...args))

const BASE = 'https://api.higgsfield.ai'

let hf: ReturnType<typeof mockHiggsfield>

beforeEach(() => {
  hf = mockHiggsfield()
})

afterEach(() => {
  hf.restore()
})

const completed = (id: string) => status(id, 'completed', { video: { url: `https://cdn/${id}.mp4` } })

test('model ids match the documented endpoints', () => {
  expect(videoModels).toEqual({
    seedanceText: 'bytedance/seedance-2.5/text-to-video',
    seedanceImage: 'bytedance/seedance-2.5/image-to-video',
    seedanceReference: 'bytedance/seedance-2.5/reference-to-video',
    wanReference: 'alibaba/wan-3.0/reference-to-video'
  })
})

test('seedanceText returns the video url', async () => {
  hf.reply(queued('r1'), completed('r1'))
  const result = await generateVideo('seedanceText', { prompt: 'waves', duration: 8, aspect_ratio: '21:9' })

  expect(result).toEqual({ requestId: 'r1', video: 'https://cdn/r1.mp4' })
  expect(hf.calls[0].url).toBe(`${BASE}/${videoModels.seedanceText}`)
  expect(hf.calls[0].body).toEqual({ prompt: 'waves', duration: 8, aspect_ratio: '21:9' })
})

test('seedanceImage sends first and last frames', async () => {
  hf.reply(queued('r1'), completed('r1'))
  await generateVideo('seedanceImage', { image_url: 'https://img/a.png', end_image_url: 'https://img/b.png' })

  expect(hf.calls[0].url).toBe(`${BASE}/${videoModels.seedanceImage}`)
  expect(hf.calls[0].body).toEqual({ image_url: 'https://img/a.png', end_image_url: 'https://img/b.png' })
})

test('wanReference submits to the Wan endpoint', async () => {
  hf.reply(queued('r1'), completed('r1'))
  await generateVideo('wanReference', { prompt: 'p', aspect_ratio: 'adaptive' })
  expect(hf.calls[0].url).toBe(`${BASE}/${videoModels.wanReference}`)
})

test('seedanceReference requires at least one reference', async () => {
  await expect(generateVideo('seedanceReference', { prompt: 'p', image_urls: [] })).rejects.toThrow(
    'needs at least one of'
  )
  await expect(queueVideo('seedanceReference', { prompt: 'p' })).rejects.toBeInstanceOf(HiggsfieldError)
  expect(hf.calls).toHaveLength(0)
})

test('seedanceReference accepts audio-only references', async () => {
  hf.reply(queued('r1'), completed('r1'))
  const result = await generateVideo('seedanceReference', { audio_urls: ['https://a/x.mp3'] })
  expect(result.video).toBe('https://cdn/r1.mp4')
})

test('throws when a completed request has no video', async () => {
  hf.reply(queued('r1'), status('r1', 'completed'))
  await expect(generateVideo('seedanceText', { prompt: 'p' })).rejects.toThrow('without a video')
})

test('caller options override the video polling defaults', async () => {
  hf.reply(queued('r1'), status('r1', 'in_progress'), completed('r1'))
  const started = Date.now()
  await generateVideo('seedanceText', { prompt: 'p' }, { pollInterval: 1 })

  // The 5s video default would make this test take seconds.
  expect(Date.now() - started).toBeLessThan(1000)
  expect(hf.calls).toHaveLength(3)
})

test('queueVideo submits without polling', async () => {
  hf.reply(queued('r1'))
  const res = await queueVideo('seedanceImage', { image_url: 'https://img/a.png' })
  expect(res.request_id).toBe('r1')
  expect(hf.calls).toHaveLength(1)
})
