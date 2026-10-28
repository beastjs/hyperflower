import { AbortTaskRunError, metadata, schemaTask, wait } from '@trigger.dev/sdk'
import { Effect, Schema } from 'effect'
import {
  HiggsfieldError,
  ImageRequest,
  queueImage,
  queueVideo,
  VideoRequest,
  waitFor,
  type QueuedRequest,
  type SubmitOptions
} from '../lib/hf'
import { runPromise } from '../lib/runtime'

export type GenerationStage = 'submitting' | 'generating'

type Submit = (options: SubmitOptions & { idempotencyKey: string }) => ReturnType<typeof queueImage>

// Higgsfield can only call back to a Trigger.dev instance it can reach.
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)|\.(local|internal)$/
const canReceiveWebhooks = () => {
  const { protocol, hostname } = new URL(process.env.TRIGGER_API_URL ?? 'https://api.trigger.dev')
  return protocol === 'https:' && !PRIVATE_HOST.test(hostname)
}

// Client errors (bad input, no credits, missing credentials) will not succeed on a retry.
const isClientError = (error: HiggsfieldError) =>
  error.httpStatus === undefined || (error.httpStatus < 500 && error.httpStatus !== 429)

// With a reachable Trigger.dev instance, Higgsfield calls the wait token's URL as its
// webhook, so the run is checkpointed (no compute billed) while the model works; if the
// webhook never arrives, the token times out and we fall back to polling. A private
// instance (e.g. self-hosted on localhost) skips the webhook and polls straight away.
const runGeneration = (submit: Submit, runId: string, webhookTimeout: string) =>
  Effect.gen(function* () {
    metadata.set('stage', 'submitting' satisfies GenerationStage)
    const token = canReceiveWebhooks()
      ? yield* Effect.promise(() => wait.createToken({ timeout: webhookTimeout }))
      : undefined

    // The run id as idempotency key makes a retried attempt reattach to the same job.
    const queued: QueuedRequest = yield* submit({ webhookUrl: token?.url, idempotencyKey: runId }).pipe(
      Effect.catchIf(isClientError, (error) => Effect.fail(new AbortTaskRunError(error.message)))
    )

    metadata.set('stage', 'generating' satisfies GenerationStage).set('requestId', queued.request_id)

    // The webhook body is not relied on; the status endpoint is the source of truth.
    if (token) yield* Effect.promise(() => wait.forToken(token))
    const result = yield* waitFor(queued.request_id, { timeout: (token ? 10 : 30) * 60_000 })

    if (result.status !== 'completed') {
      return yield* Effect.fail(new AbortTaskRunError(`Higgsfield request ended with status "${result.status}"`))
    }
    return result
  })

// schemaTask takes a plain parser; a SchemaError rejects the payload before the run starts.
const decodeImageRequest = Schema.decodeUnknownSync(ImageRequest)
const decodeVideoRequest = Schema.decodeUnknownSync(VideoRequest)

export const imageTask = schemaTask({
  id: 'generate-image',
  schema: (payload: unknown) => decodeImageRequest(payload),
  run: ({ model, input }, { ctx }) =>
    runPromise(
      Effect.gen(function* () {
        const result = yield* runGeneration((options) => queueImage(model, input, options), ctx.run.id, '10m')
        const images = result.images?.map((image) => image.url) ?? []
        if (!images.length) return yield* Effect.fail(new AbortTaskRunError('Higgsfield returned no images'))
        return { images }
      })
    )
})

export const videoTask = schemaTask({
  id: 'generate-video',
  schema: (payload: unknown) => decodeVideoRequest(payload),
  run: ({ model, input }, { ctx }) =>
    runPromise(
      Effect.gen(function* () {
        const result = yield* runGeneration((options) => queueVideo(model, input, options), ctx.run.id, '30m')
        if (!result.video?.url) return yield* Effect.fail(new AbortTaskRunError('Higgsfield returned no video'))
        return { video: result.video.url }
      })
    )
})
