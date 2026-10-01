// Stops an extension from asking again and again: three denied prompts inside
// a minute silence its prompts for ten minutes. Pure over an injected clock.

export const NAG_WINDOW_MS = 60_000
export const NAG_DENIALS = 3
export const NAG_SUSPENDED_MS = 10 * 60_000

export interface NagLimit {
  /** True while the extension's prompts are suspended. */
  suspended: (extensionId: string) => boolean
  denied: (extensionId: string) => void
  allowed: (extensionId: string) => void
}

export function createNagLimit (now: () => number = Date.now): NagLimit {
  const denials = new Map<string, number[]>()
  const until = new Map<string, number>()
  return {
    suspended: (id) => {
      const end = until.get(id)
      if (end === undefined) return false
      if (now() < end) return true
      until.delete(id)
      return false
    },
    denied: (id) => {
      const at = now()
      const recent = (denials.get(id) ?? []).filter((time) => at - time < NAG_WINDOW_MS)
      recent.push(at)
      if (recent.length >= NAG_DENIALS) {
        until.set(id, at + NAG_SUSPENDED_MS)
        denials.delete(id)
      } else {
        denials.set(id, recent)
      }
    },
    allowed: (id) => { denials.delete(id) }
  }
}
