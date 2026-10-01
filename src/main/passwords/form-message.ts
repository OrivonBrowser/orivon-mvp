// What a tab's form watcher may say to main, and what main may say back. Pure: no `electron` import. A page
// can make its own preload's messages say anything it likes only by running script in the isolated world,
// which it cannot; even so each field is bounded here, because the channel is one a renderer writes to.

export const MAX_USERNAME_LENGTH = 256
export const MAX_PASSWORD_LENGTH = 1024

export interface FieldRect { x: number, y: number, width: number, height: number }

export type FormMessage =
  | { type: 'hello' }
  | { type: 'fields', hasPassword: boolean, signUp: boolean }
  | { type: 'focus', rect: FieldRect, viewWidth: number, signUp: boolean }
  | { type: 'blur' }
  | { type: 'submit', username: string, password: string }

export type FormMessageType = FormMessage['type']

/** What main tells a watcher about itself: whether it may act, and whether a submission is worth reporting. */
export interface FormConfig { enabled: boolean, save: boolean, autofill: boolean }

export type FormCommand =
  | ({ type: 'config' } & FormConfig)
  | { type: 'fill', username: string | null, password: string, both: boolean }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** Window-content sizes and offsets far past any screen are not a place. */
const EXTENT = 100_000

function isRect (value: unknown): value is FieldRect {
  if (!isRecord(value)) return false
  return ['x', 'y', 'width', 'height'].every((key) => {
    const n = value[key]
    return typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= EXTENT
  })
}

/** The message a payload is, or null for anything else: an unknown type, a wrong field type, an oversize string. */
export function parseFormMessage (payload: unknown): FormMessage | null {
  if (!isRecord(payload)) return null
  switch (payload['type']) {
    case 'hello':
      return { type: 'hello' }
    case 'fields':
      return typeof payload['hasPassword'] === 'boolean' && typeof payload['signUp'] === 'boolean'
        ? { type: 'fields', hasPassword: payload['hasPassword'], signUp: payload['signUp'] }
        : null
    case 'focus': {
      const { rect, viewWidth, signUp } = payload
      if (!isRect(rect) || typeof signUp !== 'boolean') return null
      if (typeof viewWidth !== 'number' || !Number.isFinite(viewWidth) || viewWidth <= 0 || viewWidth > EXTENT) return null
      return { type: 'focus', rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, viewWidth, signUp }
    }
    case 'blur':
      return { type: 'blur' }
    case 'submit': {
      const { username, password } = payload
      if (typeof username !== 'string' || typeof password !== 'string') return null
      if (username.length > MAX_USERNAME_LENGTH || password.length > MAX_PASSWORD_LENGTH || password === '') return null
      return { type: 'submit', username, password }
    }
    default:
      return null
  }
}

/** Lets at most `limit` messages through per `windowMs` for each key; the rest are refused until the window rolls over. */
export function createRateLimiter (limit: number, windowMs: number, now: () => number = Date.now): (key: number) => boolean {
  const windows = new Map<number, { start: number, count: number }>()
  return (key) => {
    const at = now()
    // One entry per tab ever seen would only grow: a window that has rolled over holds nothing worth keeping.
    if (windows.size > 256) for (const [other, entry] of windows) if (at - entry.start >= windowMs) windows.delete(other)
    const current = windows.get(key)
    if (current === undefined || at - current.start >= windowMs) {
      windows.set(key, { start: at, count: 1 })
      return true
    }
    if (current.count >= limit) return false
    current.count += 1
    return true
  }
}
