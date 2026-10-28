// Daily Workers AI neuron budget. The free allowance resets at 00:00 UTC.
// Prefers Cloudflare's own analytics (account-wide); without the Account Analytics
// permission it falls back to a local tally of this app's estimated usage.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Context, Effect, Layer, Option, Schema, Semaphore } from 'effect'
import { HttpClient } from 'effect/http'
import { FREE_DAILY_NEURONS, fetchNeuronsUsedToday } from '../lib/cloudflare'

export type NeuronUsage = {
  used: number
  limit: number
  remaining: number
  /** "cloudflare" = account analytics; "estimate" = this app's own tally. */
  source: 'cloudflare' | 'estimate'
  resetsAt: string
}

const Ledger = Schema.Struct({ day: Schema.String, used: Schema.Number })
type Ledger = typeof Ledger.Type

const decodeLedger = Schema.decodeUnknownEffect(Schema.fromJsonString(Ledger))
const encodeLedger = Schema.encodeEffect(Schema.fromJsonString(Ledger))

export class LedgerError extends Schema.TaggedError<LedgerError>()('LedgerError', {
  message: Schema.String,
  cause: Schema.Defect()
}) {}

const utcDay = () => new Date().toISOString().slice(0, 10)
const round = (value: number) => Math.round(value * 100) / 100

export class NeuronLedger extends Context.Service<
  NeuronLedger,
  {
    /** Add one generation's estimated cost to today's tally. */
    record(neurons: number): Effect.Effect<void, LedgerError>
    readonly usage: Effect.Effect<NeuronUsage>
  }
>()('hyperflower/server/NeuronLedger') {
  static readonly layer = (path = join(process.cwd(), 'node_modules/.cache/hyperflower/neurons.json')) =>
    Layer.effect(
      NeuronLedger,
      Effect.gen(function* () {
        const http = yield* HttpClient.HttpClient
        // Serialize read-modify-write so concurrent generations are not lost.
        const lock = yield* Semaphore.make(1)

        // A missing or unreadable ledger, or one from an earlier day, starts a fresh day.
        const read = Effect.tryPromise(() => readFile(path, 'utf8')).pipe(
          Effect.flatMap(decodeLedger),
          Effect.filterOrFail((ledger) => ledger.day === utcDay()),
          Effect.orElseSucceed((): Ledger => ({ day: utcDay(), used: 0 }))
        )

        const record = (neurons: number) =>
          Effect.gen(function* () {
            const ledger = yield* read
            const json = yield* encodeLedger({ ...ledger, used: round(ledger.used + neurons) })
            yield* Effect.tryPromise(async () => {
              await mkdir(dirname(path), { recursive: true })
              await writeFile(path, json)
            })
          }).pipe(
            Effect.mapError((cause) => new LedgerError({ message: 'Could not update the neuron ledger', cause })),
            lock.withPermits(1),
            Effect.withSpan('NeuronLedger.record')
          )

        const usage = Effect.gen(function* () {
          const [ledger, account] = yield* Effect.all(
            [read, fetchNeuronsUsedToday().pipe(Effect.option, Effect.provideService(HttpClient.HttpClient, http))],
            { concurrency: 'unbounded' }
          )
          // Analytics lag a few minutes, so never report less than this app has just spent.
          const used = round(Math.max(Option.getOrElse(account, () => 0), ledger.used))
          const resetsAt = new Date(`${utcDay()}T00:00:00Z`)
          resetsAt.setUTCDate(resetsAt.getUTCDate() + 1)
          return {
            used,
            limit: FREE_DAILY_NEURONS,
            remaining: Math.max(0, round(FREE_DAILY_NEURONS - used)),
            source: Option.isNone(account) ? 'estimate' : 'cloudflare',
            resetsAt: resetsAt.toISOString()
          } satisfies NeuronUsage
        }).pipe(Effect.withSpan('NeuronLedger.usage'))

        return NeuronLedger.of({ record, usage })
      })
    )
}
