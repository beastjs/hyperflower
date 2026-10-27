import { AbortTaskRunError, metadata, task, wait } from '@trigger.dev/sdk'
import {
  HiggsfieldError,
  queueImage,
  queueVideo,
  waitFor,
  type ImageRequest,
  type QueuedRequest,
  type RequestResult,
  type VideoRequest
} from '../lib/hf'

export type GenerationStage = 'submitting' | 'generating'

type Submit = (options: { webhookUrl?: string; idempotencyKey: string }) => Promise<QueuedRequest>

// Higgsfield can only call back to a Trigger.dev instance it can reach.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)|\.(local|internal)$/
const canReceiveWebhooks = () => {
  const { protocol, hostname } = new URL(process.env.TRIGGER_API_URL ?? 'https://api.trigger.dev')
  return protocol === 'https:' && !PRIVATE_HOST.test(hostname)
}

// With a reachable Trigger.dev instance, Higgsfield calls the wait token's URL as its
// webhook, so the run is checkpointed (no compute billed) while the model works; if the
// webhook never arrives, the token times out and we fall back to polling. A private
// instance (e.g. self-hosted on localhost) skips the webhook and polls straight away.
async function runGeneration(submit: Submit, runId: string, webhookTimeout: string): Promise<RequestResult> {
  metadata.set('stage', 'submitting' satisfies GenerationStage)
  const token = canReceiveWebhooks() ? await wait.createToken({ timeout: webhookTimeout }) : undefined

  let queued: QueuedRequest
  try {
    // The run id as idempotency key makes a retried attempt reattach to the same job.
    queued = await submit({ webhookUrl: token?.url, idempotencyKey: runId })
  } catch (error) {
    const isClientError =
      error instanceof HiggsfieldError &&
      (error.httpStatus === undefined || (error.httpStatus < 500 && error.httpStatus !== 429))
    if (isClientError) throw new AbortTaskRunError(error.message)
    throw error
  }

  metadata.set('stage', 'generating' satisfies GenerationStage).set('requestId', queued.request_id)

  // The webhook body is not relied on; the status endpoint is the source of truth.
  if (token) await wait.forToken(token)
  const result = await waitFor(queued.request_id, { timeout: (token ? 10 : 30) * 60_000 })

  if (result.status !== 'completed') {
    throw new AbortTaskRunError(`Higgsfield request ended with status "${result.status}"`)
  }
  return result
}

export const imageTask = task({
  id: 'generate-image',
  run: async ({ model, input }: ImageRequest, { ctx }) => {
    const result = await runGeneration((options) => queueImage(model, input, options), ctx.run.id, '10m')
    const images = result.images?.map((image) => image.url) ?? []
    if (!images.length) throw new AbortTaskRunError('Higgsfield returned no images')
    return { images }
  }
})

export const videoTask = task({
  id: 'generate-video',
  run: async ({ model, input }: VideoRequest, { ctx }) => {
    const result = await runGeneration((options) => queueVideo(model, input, options), ctx.run.id, '30m')
    if (!result.video?.url) throw new AbortTaskRunError('Higgsfield returned no video')
    return { video: result.video.url }
  }
})
