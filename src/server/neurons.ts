// Daily Workers AI neuron budget. The free allowance resets at 00:00 UTC.
// Prefers Cloudflare's own analytics (account-wide); without the Account Analytics
// permission it falls back to a local tally of this app's estimated usage.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { FREE_DAILY_NEURONS, fetchNeuronsUsedToday } from '../lib/cloudflare'

export type NeuronUsage = {
  used: number
  limit: number
  remaining: number
  /** "cloudflare" = account analytics; "estimate" = this app's own tally. */
  source: 'cloudflare' | 'estimate'
  resetsAt: string
}

type Ledger = { day: string; used: number }

const LEDGER = join(process.cwd(), 'node_modules/.cache/hyperflower/neurons.json')
const utcDay = () => new Date().toISOString().slice(0, 10)

async function readLedger(): Promise<Ledger> {
  try {
    const ledger = JSON.parse(await readFile(LEDGER, 'utf8')) as Ledger
    if (ledger.day === utcDay()) return ledger
  } catch {
    // Missing or unreadable ledger starts a fresh day.
  }
  return { day: utcDay(), used: 0 }
}

let writes = Promise.resolve()

/** Add one generation's estimated cost to today's tally. */
export function recordNeurons(neurons: number) {
  // Serialize read-modify-write so concurrent generations are not lost.
  const write = writes.then(async () => {
    const ledger = await readLedger()
    ledger.used = Math.round((ledger.used + neurons) * 100) / 100
    await mkdir(dirname(LEDGER), { recursive: true })
    await writeFile(LEDGER, JSON.stringify(ledger))
  })
  // One failed write must not block the ones queued after it.
  writes = write.catch(() => {})
  return write
}

export async function getNeuronUsage(): Promise<NeuronUsage> {
  const [ledger, account] = await Promise.all([readLedger(), fetchNeuronsUsedToday().catch(() => undefined)])
  // Analytics lag a few minutes, so never report less than this app has just spent.
  const used = Math.round(Math.max(account ?? 0, ledger.used) * 100) / 100
  const resetsAt = new Date(`${utcDay()}T00:00:00Z`)
  resetsAt.setUTCDate(resetsAt.getUTCDate() + 1)
  return {
    used,
    limit: FREE_DAILY_NEURONS,
    remaining: Math.max(0, Math.round((FREE_DAILY_NEURONS - used) * 100) / 100),
    source: account === undefined ? 'estimate' : 'cloudflare',
    resetsAt: resetsAt.toISOString()
  }
}
