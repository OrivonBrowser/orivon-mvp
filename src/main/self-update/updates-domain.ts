// What the Settings page may ask about updates: to look now. Whether Orivon
// looks by itself is a setting. It only reads whether a newer release exists,
// and never installs one (`update-check.ts`). A private session looks at nothing.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { UpdateAnswer } from './update-check-runner.js'

/**
 * `notify` defaults to a no-op so a caller that does not care about a second
 * open Settings window -- every existing test -- needs no change. The real
 * one (start-internal-pages.ts) broadcasts the answer this tab just found to
 * every other one, since "check now" is the only source of this section's
 * state and nothing else can trigger a background change to push instead.
 */
export function updatesDomain (checkNow: () => Promise<UpdateAnswer>, isPrivate: boolean, notify: (answer: UpdateAnswer) => void = () => {}): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'check') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      const answer = await checkNow()
      notify(answer)
      return { ok: true, answer }
    }
  }
}
