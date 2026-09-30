// The process's one set of pending sign-ins, shared by the login handler, the sheet and the tab events that end
// them, and what happens when a remembered sign-in has proved to work.
import { randomBytes } from 'node:crypto'
import type { OverlayWindow } from '../overlays/overlay-types.js'
import type { PasswordVault } from '../passwords/vault.js'
import { AuthChallenges } from './auth-queue.js'

export const challenges = new AuthChallenges({
  schedule: (run, ms) => {
    const timer = setTimeout(run, ms)
    timer.unref()
    return () => { clearTimeout(timer) }
  },
  newId: () => randomBytes(12).toString('hex')
})

/** A sign-in the person asked to remember is saved once the page has stopped loading; if the server asks again first, it was wrong and nothing is saved. */
export const REMEMBER_FALLBACK_MS = 8000

export function rememberWhenLoaded (window: OverlayWindow['window'], tabId: string, vault: PasswordVault, all: AuthChallenges = challenges): void {
  const settle = (): void => {
    const login = all.takeRemember(window, tabId)
    if (login === undefined) return
    void vault.save(login).catch((error: unknown) => { console.error('[auth] keeping a password failed:', error instanceof Error ? error.message : 'unknown') })
  }
  const contents = window.tabs.liveWebContents(tabId)
  contents?.once('did-stop-loading', settle)
  setTimeout(settle, REMEMBER_FALLBACK_MS).unref()
}
