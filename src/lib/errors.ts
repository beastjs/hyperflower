// Error messages shown as dismissible callouts. They are kept in localStorage so a failure that
// arrives while the tab is reloaded or closed (a 12-minute 3D job, say) is still there afterwards.

export type ErrorNotice = {
  id: string
  /** What failed, e.g. the model name; omitted for form validation. */
  title?: string
  message: string
  at: number
}

const KEY = 'hyperflower:errors'
const MAX = 20

/** Storage can be missing or throw (private windows, blocked site data); the app works without it. */
export function loadErrors(): ErrorNotice[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(parsed)
      ? parsed.filter((n): n is ErrorNotice => typeof n?.id === 'string' && typeof n?.message === 'string')
      : []
  } catch {
    return []
  }
}

export function saveErrors(notices: ErrorNotice[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(notices))
  } catch {}
}

/** Newest first; the same message again replaces the older copy instead of stacking. */
export const addError = (notices: ErrorNotice[], notice: Omit<ErrorNotice, 'id' | 'at'>): ErrorNotice[] => [
  { ...notice, id: crypto.randomUUID(), at: Date.now() },
  ...notices.filter((n) => n.message !== notice.message || n.title !== notice.title)
].slice(0, MAX)
