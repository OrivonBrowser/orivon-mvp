// What the Settings page may ask about updates: to look now. Whether Orivon
// looks by itself is a setting. It only reads whether a newer release exists,
// and never installs one (`update-check.ts`). A private session looks at nothing.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { UpdateAnswer } from './update-check-runner.js'

export function updatesDomain (checkNow: () => Promise<UpdateAnswer>, isPrivate: boolean): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'check') return undefined
      return isPrivate ? { ok: false, reason: 'private' } : { ok: true, answer: await checkNow() }
    }
  }
}
