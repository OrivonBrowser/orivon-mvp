// What the Settings page may ask about updates: to look now, and to see the page of the release that was found.
// Whether Orivon looks by itself is a setting. It only reads whether a newer release exists, and never installs
// one (`update-check.ts`). A private session looks at nothing.
import type { InternalCaller, InternalDomain } from '../pages/internal-ipc.js'
import { releaseUrl } from './release-url.js'
import type { UpdateAnswer } from './update-check-runner.js'

/**
 * `notify` defaults to a no-op so a caller that does not care about a second
 * open Settings window -- every existing test -- needs no change. The real
 * one (start-internal-pages.ts) broadcasts the answer this tab just found to
 * every other one, since "check now" is the only source of this section's
 * state and nothing else can trigger a background change to push instead.
 */
export function updatesDomain (
  checkNow: () => Promise<UpdateAnswer>,
  isPrivate: boolean,
  notify: (answer: UpdateAnswer) => void = () => {},
  /** Opens `url` in a new tab of the window `caller` is in. */
  openPage: (caller: InternalCaller, url: string) => void = () => {}
): InternalDomain {
  /** The tag of the newer release the last check found. The page never says which page to open: only that it wants this one. */
  let found: string | null = null
  return {
    pages: ['settings'],
    handle: async (command, caller) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'check' && type !== 'openRelease') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      if (type === 'openRelease') {
        if (found === null) return { ok: false, reason: 'none' }
        openPage(caller, releaseUrl(found))
        return { ok: true }
      }
      const answer = await checkNow()
      found = answer.newer ? answer.latest : null
      notify(answer)
      return { ok: true, answer }
    }
  }
}
