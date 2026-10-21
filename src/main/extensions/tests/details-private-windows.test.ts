import { describe, expect, it } from 'vitest'
import { privateWindowsPart, setPrivateWindows } from '../details-private-windows.js'
import { DETAIL_PARTS } from '../extensions-detail-parts.js'
import { EXTENSION_PAGE_COMMANDS } from '../extensions-page-commands.js'
import type { ExtensionsDomainDeps } from '../extensions-domain.js'
import { createExtensionPrefsStore } from '../extension-prefs-runner.js'
import type { ExtensionFacts } from '../extensions-view.js'
import type { InstalledExtension } from '../registry.js'

const ID = 'a'.repeat(32)
const entry = { id: ID } as InstalledExtension
const facts = {} as ExtensionFacts

function deps (isPrivate = false): { deps: ExtensionsDomainDeps, prefs: ReturnType<typeof createExtensionPrefsStore> } {
  const prefs = createExtensionPrefsStore(null)
  return { prefs, deps: { prefs, isPrivate, extensions: { list: () => [entry] } } as unknown as ExtensionsDomainDeps }
}

describe('the "Run in private windows" part', () => {
  it('is registered, with its command', () => {
    expect(DETAIL_PARTS).toContain(privateWindowsPart)
    expect(EXTENSION_PAGE_COMMANDS['setPrivateWindows']).toBe(setPrivateWindows)
  })

  it('says whether the extension is allowed, off until the person allows it', () => {
    const { deps: value, prefs } = deps()
    expect(privateWindowsPart(entry, facts, value)).toEqual({ privateWindows: { enabled: false } })
    prefs.update(ID, { privateWindows: true })
    expect(privateWindowsPart(entry, facts, value)).toEqual({ privateWindows: { enabled: true } })
  })

  it('is left out of the page shown in a private window', () => {
    expect(privateWindowsPart(entry, facts, deps(true).deps)).toEqual({})
  })
})

describe('setPrivateWindows', () => {
  it('allows and takes back an installed extension', () => {
    const { deps: value, prefs } = deps()
    expect(setPrivateWindows({ id: ID, enabled: true }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).privateWindows).toBe(true)
    expect(setPrivateWindows({ id: ID, enabled: false }, value)).toEqual({ ok: true })
    expect(prefs.get(ID).privateWindows).toBe(false)
  })

  it('refuses what is not a boolean for an installed extension', () => {
    const { deps: value, prefs } = deps()
    for (const body of [{}, { id: ID }, { id: ID, enabled: 'yes' }, { id: 7, enabled: true }, { id: 'b'.repeat(32), enabled: true }]) {
      expect(setPrivateWindows(body, value)).toBeUndefined()
    }
    expect(prefs.get(ID).privateWindows).toBe(false)
  })

  it('refuses from a private window, where the copies are not changed', () => {
    const { deps: value, prefs } = deps(true)
    expect(setPrivateWindows({ id: ID, enabled: true }, value)).toBeUndefined()
    expect(prefs.get(ID).privateWindows).toBe(false)
  })
})
