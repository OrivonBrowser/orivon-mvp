import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

// permission-gate.ts imports { app, session } directly from 'electron' at
// module scope -- outside a real Electron process this cannot even be
// imported without mocking it first (same reasoning as tabs.test.ts and
// registry.test.ts). `fakeApp` is a REAL EventEmitter, not a bag of
// vi.fn() no-ops, because the second test below depends on actually
// firing 'session-created', the same way Electron itself would.
interface FakeSession {
  setPermissionRequestHandler: ReturnType<typeof vi.fn>
  setPermissionCheckHandler: ReturnType<typeof vi.fn>
  setDevicePermissionHandler: ReturnType<typeof vi.fn>
}

function makeFakeSession (): FakeSession {
  return {
    setPermissionRequestHandler: vi.fn(),
    setPermissionCheckHandler: vi.fn(),
    setDevicePermissionHandler: vi.fn()
  }
}

const fakeApp = new EventEmitter()
const fakeDefaultSession = makeFakeSession()

vi.mock('electron', () => ({
  app: fakeApp,
  session: { defaultSession: fakeDefaultSession }
}))

const { permissionGateSubsystem } = await import('../permission-gate.js')

// Electron's full permission vocabulary, merged from BOTH handler
// signatures (session.md's own two lists differ slightly: 'display-
// capture', 'keyboardLock', 'speaker-selection', 'window-management' and
// 'unknown' are request-only; 'hid', 'serial', 'usb' and 'deprecated-
// sync-clipboard-read' are check-only) -- every one, from either list,
// must deny by default.
const ALL_PERMISSIONS = [
  'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen',
  'geolocation', 'idle-detection', 'media', 'mediaKeySystem', 'midi', 'midiSysex',
  'notifications', 'pointerLock', 'keyboardLock', 'openExternal', 'speaker-selection',
  'storage-access', 'top-level-storage-access', 'window-management', 'unknown',
  'fileSystem', 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read'
]

/** Reads back whatever `denyByDefault` most recently installed on `target`
 * and exposes it as plain predicates, so a test can drive the same
 * handler shapes Electron itself would call. */
function installedHandlers (target: FakeSession): {
  request: (permission: string) => boolean
  check: (permission: string) => boolean
  device: () => boolean
} {
  const requestHandler = target.setPermissionRequestHandler.mock.calls.at(-1)?.[0]
  const checkHandler = target.setPermissionCheckHandler.mock.calls.at(-1)?.[0]
  const deviceHandler = target.setDevicePermissionHandler.mock.calls.at(-1)?.[0]
  return {
    request: (permission) => {
      let granted: boolean | undefined
      requestHandler({}, permission, (result: boolean) => { granted = result })
      return granted === true
    },
    check: (permission) => checkHandler({}, permission, 'https://example.com', {}) === true,
    device: () => deviceHandler({}) === true
  }
}

describe('permissionGateSubsystem', () => {
  it('is critical: the deny-by-default gate not installing must not boot a browser that silently approves everything', () => {
    expect(permissionGateSubsystem.critical).toBe(true)
  })

  it('denies every Electron permission by default on session.defaultSession', () => {
    permissionGateSubsystem.beforeReady?.()
    // afterReady takes a SubsystemContext, but this subsystem reads
    // nothing off it -- only `session.defaultSession`, module-level.
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    for (const permission of ALL_PERMISSIONS) {
      expect(handlers.request(permission)).toBe(false)
      expect(handlers.check(permission)).toBe(false)
    }
    expect(handlers.device()).toBe(false)
  })

  it('reaches a newly created per-origin partition session too, not just the default one', () => {
    permissionGateSubsystem.beforeReady?.()

    const partitionSession = makeFakeSession()
    // The real trigger is Electron's own session.fromPartition(), called
    // internally when a WebContentsView is constructed with
    // webPreferences.partition set -- exactly what tab-view.ts's
    // makeTabView() does for every non-dashboard tab. Electron fires
    // 'session-created' synchronously the first time that partition
    // string is seen; this emit stands in for that.
    fakeApp.emit('session-created', partitionSession)

    const handlers = installedHandlers(partitionSession)
    for (const permission of ALL_PERMISSIONS) {
      expect(handlers.request(permission)).toBe(false)
      expect(handlers.check(permission)).toBe(false)
    }
    expect(handlers.device()).toBe(false)
  })
})
