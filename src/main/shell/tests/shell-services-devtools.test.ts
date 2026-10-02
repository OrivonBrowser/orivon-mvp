// Whether DevToolsService.allowed() actually refuses the shell's own UI
// outside developer mode depends on what shell-services.ts wires as its
// isShellPage dependency -- this proves that wiring, not just the formula
// (devtools-service.test.ts) or the predicate alone (shell-ui-page.test.ts).
import { describe, expect, it } from 'vitest'
import type { Session, WebContents } from 'electron'
import { InternalPageRegistry } from '../../pages/internal-registry.js'
import { DevToolsService } from '../../devtools/devtools-service.js'
import { isShellUiPage } from '../shell-ui-page.js'

const SHELL_SESSION = {} as Session
const OTHER_SESSION = {} as Session

function contents (session: Session): WebContents {
  return { session, isDestroyed: () => false, once: () => {} } as unknown as WebContents
}

function service (developerMode: () => boolean): DevToolsService {
  const internalPages = new InternalPageRegistry()
  const settings = { get: () => true, onChange: () => () => {} }
  return new DevToolsService(settings as never, {
    appOf: () => null,
    isShellPage: (c) => isShellUiPage(c, internalPages, SHELL_SESSION),
    developerMode,
    confirm: async () => true
  })
}

describe('DevToolsService, wired the way shell-services.ts wires it', () => {
  it('refuses a page in the shell\'s own session, with developer.tools on and dev mode off', () => {
    expect(service(() => false).allowed(contents(SHELL_SESSION))).toBe(false)
  })

  it('allows the same page in developer mode', () => {
    expect(service(() => true).allowed(contents(SHELL_SESSION))).toBe(true)
  })

  it('leaves an ordinary page unchanged, dev mode or not', () => {
    expect(service(() => false).allowed(contents(OTHER_SESSION))).toBe(true)
    expect(service(() => true).allowed(contents(OTHER_SESSION))).toBe(true)
  })
})
