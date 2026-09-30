import { describe, expect, it } from 'vitest'
import type { Session, WebContents } from 'electron'
import { InternalPageRegistry } from '../../pages/internal-registry.js'
import { isShellUiPage } from '../shell-ui-page.js'

const SHELL_SESSION = {} as Session
const OTHER_SESSION = {} as Session

let nextId = 1
function contents (session: Session): WebContents {
  return { id: nextId++, session, isDestroyed: () => false, once: () => {} } as unknown as WebContents
}

describe('isShellUiPage', () => {
  it('is true for a registered internal page, whatever session it runs in', () => {
    const internalPages = new InternalPageRegistry()
    const page = contents(OTHER_SESSION)
    internalPages.register(page, 'settings')

    expect(isShellUiPage(page, internalPages, SHELL_SESSION)).toBe(true)
  })

  it('is true for any other view in the shell\'s own session -- the chrome, a popover, the intro screen', () => {
    const internalPages = new InternalPageRegistry()

    expect(isShellUiPage(contents(SHELL_SESSION), internalPages, SHELL_SESSION)).toBe(true)
  })

  it('is false for an ordinary page: not registered, and not in the shell\'s session', () => {
    const internalPages = new InternalPageRegistry()

    expect(isShellUiPage(contents(OTHER_SESSION), internalPages, SHELL_SESSION)).toBe(false)
  })
})
