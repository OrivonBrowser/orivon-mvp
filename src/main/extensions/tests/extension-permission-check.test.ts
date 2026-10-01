import { describe, expect, it, vi } from 'vitest'
import { createPermissionHeld, installPermissionCheck, isStrippedPermissionName, permissionHeld } from '../extension-permission-check.js'
import { createMemoryExtensionPrefs } from '../extension-prefs-stub.js'

const ID = 'a'.repeat(32)

function deps (over: { stripped?: string[], manifest?: string[] | undefined } = {}) {
  const prefs = createMemoryExtensionPrefs()
  return {
    prefs,
    stripped: () => over.stripped ?? [],
    manifestPermissions: () => over.manifest
  }
}

describe('isStrippedPermissionName', () => {
  it('names the permissions the loaded manifest no longer carries', () => {
    for (const name of ['nativeMessaging', 'declarativeNetRequest', 'declarativeNetRequestWithHostAccess', 'declarativeNetRequestFeedback', 'webRequest', 'webRequestBlocking']) {
      expect(isStrippedPermissionName(name)).toBe(true)
    }
    for (const name of ['tabs', 'storage', 'activeTab', 'history']) expect(isStrippedPermissionName(name)).toBe(false)
  })
})

describe('permissionHeld', () => {
  it('answers a stripped name from the original record, never from the loaded manifest or the grants', () => {
    const d = deps({ stripped: ['webRequest'], manifest: ['webRequest'] })
    d.prefs.update(ID, { granted: { permissions: ['webRequestBlocking'], origins: [] } })
    const held = createPermissionHeld(d)
    expect(held(ID, 'webRequest')).toBe(true)
    expect(held(ID, 'webRequestBlocking')).toBe(false)
    expect(createPermissionHeld(deps({ manifest: ['webRequest'] }))(ID, 'webRequest')).toBe(false)
  })

  it('reads declarativeNetRequest as either of its two permissions, and feedback as neither', () => {
    expect(createPermissionHeld(deps({ stripped: ['declarativeNetRequest'] }))(ID, 'declarativeNetRequest')).toBe(true)
    expect(createPermissionHeld(deps({ stripped: ['declarativeNetRequestWithHostAccess'] }))(ID, 'declarativeNetRequest')).toBe(true)
    expect(createPermissionHeld(deps({ stripped: ['declarativeNetRequestFeedback'] }))(ID, 'declarativeNetRequest')).toBe(false)
    expect(createPermissionHeld(deps({ stripped: ['declarativeNetRequestFeedback'] }))(ID, 'declarativeNetRequestFeedback')).toBe(true)
  })

  it('answers any other name from the loaded manifest', () => {
    const held = createPermissionHeld(deps({ manifest: ['tabs'] }))
    expect(held(ID, 'tabs')).toBe(true)
    expect(held(ID, 'history')).toBe(false)
  })

  it('falls back to what the person granted at runtime', () => {
    const d = deps({ manifest: ['tabs'] })
    const held = createPermissionHeld(d)
    expect(held(ID, 'history')).toBe(false)
    d.prefs.update(ID, { granted: { permissions: ['history'], origins: [] } })
    expect(held(ID, 'history')).toBe(true)
    d.prefs.forget(ID)
    expect(held(ID, 'history')).toBe(false)
  })

  it('holds nothing for an extension that is not loaded and has no grants', () => {
    expect(createPermissionHeld(deps())(ID, 'tabs')).toBe(false)
  })
})

describe('installPermissionCheck', () => {
  it('registers the check once and answers the module-level permissionHeld from it', () => {
    const register = vi.fn()
    expect(permissionHeld(ID, 'tabs')).toBe(false)
    const held = installPermissionCheck(deps({ manifest: ['tabs'] }), register)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(held)
    expect(permissionHeld(ID, 'tabs')).toBe(true)
    expect(permissionHeld(ID, 'history')).toBe(false)
  })
})
