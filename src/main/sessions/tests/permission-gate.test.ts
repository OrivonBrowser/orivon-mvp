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
// must deny unless ALLOWED names it.
const ALL_PERMISSIONS = [
  'clipboard-read', 'clipboard-sanitized-write', 'display-capture', 'fullscreen',
  'geolocation', 'idle-detection', 'media', 'mediaKeySystem', 'midi', 'midiSysex',
  'notifications', 'pointerLock', 'keyboardLock', 'openExternal', 'speaker-selection',
  'storage-access', 'top-level-storage-access', 'window-management', 'unknown',
  'fileSystem', 'hid', 'serial', 'usb', 'deprecated-sync-clipboard-read',
  // Check-only names measured against a real page: Chromium asks for these
  // on every popup and every requestFullscreen(), whatever the page does.
  'automatic-fullscreen', 'web-app-installation'
]

/** The gate's allowlist, restated here rather than imported: a test that
 * read the same constant the implementation does would agree with it
 * however it changed, which is the one thing this file exists to stop.
 * `fileSystem` is absent on purpose: it is allowed only with details naming
 * one file, which the matrix below never sends, and has its own cases. */
const ALLOWED = ['clipboard-sanitized-write', 'fullscreen']

// The details Electron passes for a File System Access operation, measured
// against a real page: every read and write reaches the check handler with
// `filePath`, `isDirectory` and `fileAccessType`.
const FILE = { filePath: '/home/person/freetube-subscriptions.db', isDirectory: false }
const DIRECTORY = { filePath: '/home/person', isDirectory: true }
const ACCESS_TYPES = ['readable', 'writable'] as const

/** Every name that must still deny -- derived, so a permission added to
 * ALL_PERMISSIONS is covered without anyone remembering to list it. */
const DENIED_PERMISSIONS = ALL_PERMISSIONS.filter((p) => !ALLOWED.includes(p))

/** Asserts the whole matrix for one session: the allowlist is granted on
 * both handlers, everything else is refused on both, and no device
 * permission is ever granted. Shared by the two session cases below so
 * neither can drift into checking less than the other. */
function expectGateMatrix (handlers: { request: (p: string) => boolean, check: (p: string) => boolean, device: () => boolean }): void {
  for (const permission of DENIED_PERMISSIONS) {
    expect(handlers.request(permission)).toBe(false)
    expect(handlers.check(permission)).toBe(false)
  }
  for (const permission of ALLOWED) {
    expect(handlers.request(permission)).toBe(true)
    expect(handlers.check(permission)).toBe(true)
  }
  expect(handlers.device()).toBe(false)
}

/** Reads back whatever `denyByDefault` most recently installed on `target`
 * and exposes it as plain predicates, so a test can drive the same
 * handler shapes Electron itself would call. */
function installedHandlers (target: FakeSession): {
  request: (permission: string, details?: object) => boolean
  check: (permission: string, details?: object) => boolean
  device: () => boolean
} {
  const requestHandler = target.setPermissionRequestHandler.mock.calls.at(-1)?.[0]
  const checkHandler = target.setPermissionCheckHandler.mock.calls.at(-1)?.[0]
  const deviceHandler = target.setDevicePermissionHandler.mock.calls.at(-1)?.[0]
  return {
    request: (permission, details = {}) => {
      let granted: boolean | undefined
      requestHandler({}, permission, (result: boolean) => { granted = result }, details)
      return granted === true
    },
    check: (permission, details = {}) => checkHandler({}, permission, 'https://example.com', details) === true,
    device: () => deviceHandler({}) === true
  }
}

describe('permissionGateSubsystem', () => {
  it('is critical: the deny-by-default gate not installing must not boot a browser that silently approves everything', () => {
    expect(permissionGateSubsystem.critical).toBe(true)
  })

  it('denies every Electron permission but the allowlist on session.defaultSession', () => {
    permissionGateSubsystem.beforeReady?.()
    // afterReady takes a SubsystemContext, but this subsystem reads
    // nothing off it -- only `session.defaultSession`, module-level.
    void permissionGateSubsystem.afterReady?.({} as never)

    expectGateMatrix(installedHandlers(fakeDefaultSession))
  })

  // The two names that must never join the allowlist, asserted by name
  // rather than by falling out of DENIED_PERMISSIONS: writing the
  // clipboard needs the person to have just acted in the page, reading it
  // hands over whatever they last copied anywhere else.
  it('keeps both clipboard READ permissions denied, on both handlers', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    for (const permission of ['clipboard-read', 'deprecated-sync-clipboard-read']) {
      expect(handlers.request(permission)).toBe(false)
      expect(handlers.check(permission)).toBe(false)
    }
  })

  // Guards the blast radius of the allowlist itself: a later edit that
  // adds a name gets a failing test naming it, rather than silently
  // widening what every page in the browser may do.
  it('allows exactly clipboard write and fullscreen when no file is named', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    const granted = ALL_PERMISSIONS.filter((permission) => handlers.request(permission) || handlers.check(permission))
    expect(granted).toEqual(['clipboard-sanitized-write', 'fullscreen'])
  })

  // `fullscreen` is safe to allow because Chromium only grants it to a page
  // the person just clicked in. `automatic-fullscreen` is the name that
  // waives that click, so allowing it would remove the whole basis.
  it('keeps automatic-fullscreen denied, on both handlers', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    expect(handlers.request('automatic-fullscreen')).toBe(false)
    expect(handlers.check('automatic-fullscreen')).toBe(false)
  })

  // An import reads the file the person picked; an export writes the file
  // they chose to save as. Both arrive as one file, and both must pass.
  it('allows fileSystem for one file, to read or to write, on both handlers', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    for (const fileAccessType of ACCESS_TYPES) {
      expect(handlers.check('fileSystem', { ...FILE, fileAccessType })).toBe(true)
      expect(handlers.request('fileSystem', { ...FILE, fileAccessType })).toBe(true)
    }
  })

  // A directory grant reaches every file beneath it, and details that do not
  // say "one file" are not trusted to mean it.
  it('refuses fileSystem for a directory, and whenever the details do not say it is one file', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    for (const fileAccessType of ACCESS_TYPES) {
      expect(handlers.check('fileSystem', { ...DIRECTORY, fileAccessType })).toBe(false)
      expect(handlers.request('fileSystem', { ...DIRECTORY, fileAccessType })).toBe(false)
    }
    for (const details of [{}, { filePath: FILE.filePath }, { ...FILE, isDirectory: 'false' }]) {
      expect(handlers.check('fileSystem', details)).toBe(false)
      expect(handlers.request('fileSystem', details)).toBe(false)
    }
  })

  // Guards the order of the predicate: file details must widen fileSystem
  // and nothing else, so a name checked after `isDirectory` fails here.
  it('lets file details widen no permission but fileSystem', () => {
    permissionGateSubsystem.beforeReady?.()
    void permissionGateSubsystem.afterReady?.({} as never)

    const handlers = installedHandlers(fakeDefaultSession)
    const details = { ...FILE, fileAccessType: 'writable' }
    const granted = ALL_PERMISSIONS.filter((permission) => handlers.request(permission, details) || handlers.check(permission, details))
    expect(granted).toEqual(['clipboard-sanitized-write', 'fullscreen', 'fileSystem'])
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

    expectGateMatrix(installedHandlers(partitionSession))
  })
})
