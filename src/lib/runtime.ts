// Shared Effect wiring for server-side code: config from process.env and a fetch-backed HttpClient.
// Server-side only: keep this module out of the browser bundle.

import { ConfigProvider, Effect, Layer } from 'effect'
import { FetchHttpClient, HttpClient, type HttpClientRequest } from 'effect/http'

// The default provider snapshots process.env once; Vite reloads .env into process.env
// and tests swap variables per case, so read the environment on every lookup.
const liveEnv = ConfigProvider.make((path) => Effect.suspend(() => ConfigProvider.fromEnv().load(path)))

// Likewise resolve fetch per request rather than caching the first globalThis.fetch.
const lazyFetch = ((input, init) => globalThis.fetch(input, init)) as typeof globalThis.fetch

/** Everything the provider clients need: HttpClient plus env-backed Config. */
export const BaseLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.Fetch, lazyFetch),
  ConfigProvider.layer(liveEnv)
)

/** Run a provider effect outside a ManagedRuntime, e.g. in tests or one-off scripts. */
export const runPromise = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  options?: Effect.RunOptions
): Promise<A> => Effect.runPromise(Effect.provide(effect, BaseLayer), options)

export type RawResponse = {
  status: number
  ok: boolean
  /** Parsed JSON, the raw text when it is not JSON, or undefined for an empty body. */
  body: unknown
}

const parseBody = (text: string): unknown => {
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * Send a request and read its body leniently: provider error bodies are not always JSON,
 * and callers decode the parts they need with Schema. Fails only on transport errors.
 */
export const execute = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.execute(request)
    const text = yield* response.text
    return { status: response.status, ok: response.status >= 200 && response.status < 300, body: parseBody(text) }
  })
