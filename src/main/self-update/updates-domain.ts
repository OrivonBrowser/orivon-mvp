// What the Settings page may ask about updates: to look now, to see the page of the release that was found, and to
// install it. Whether Orivon looks by itself is a setting. Main installs only the release it found itself, never one
// the page names, and only when asked. A private session looks at nothing.
import type { InternalCaller, InternalDomain } from '../pages/internal-ipc.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { releaseUrl } from './release-url.js'
import type { SelfUpdate } from './self-update.js'

export function updatesDomain (
  updates: Pick<SelfUpdate, 'checkNow' | 'install' | 'answer' | 'foundTag'>,
  isPrivate: boolean,
  /** Opens `url` in a new tab of the window `caller` is in. */
  openPage: (caller: InternalCaller, url: string) => void = () => {},
  windowOf: (caller: InternalCaller) => ShellWindow | undefined = () => undefined
): InternalDomain {
  return {
    pages: ['settings'],
    handle: async (command, caller) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'check' && type !== 'openRelease' && type !== 'install') return undefined
      if (isPrivate) return { ok: false, reason: 'private' }
      if (type === 'openRelease') {
        const tag = updates.foundTag()
        if (tag === null) return { ok: false, reason: 'none' }
        openPage(caller, releaseUrl(tag))
        return { ok: true }
      }
      if (type === 'install') {
        const answer = updates.answer()
        if (!answer.newer) return { ok: false, reason: 'none' }
        if (!answer.canInstall) return { ok: false, reason: 'unavailable' }
        // The install reports through `updates.changed`; the reply only says it started.
        if (answer.phase !== 'downloading' && answer.phase !== 'installing') void updates.install(windowOf(caller))
        return { ok: true }
      }
      return { ok: true, answer: await updates.checkNow() }
    }
  }
}
