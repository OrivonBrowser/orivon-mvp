import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'

// A handler registered through ctx.handle sits on the library's own router, so
// the sender-id check decides who reaches it: the extension's own frame and
// worker, and nothing else. Driven through the real router and the real check.
const handles = new Map<string, (...args: any[]) => unknown>()

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: any[]) => unknown) => { handles.set(channel, fn) }),
    on: vi.fn()
  }
}))

const { ExtensionRouter, setMessageSenderIdCheck, setPermissionCheck } = await import(
  '../../../../../vendor/electron-chrome-extensions/src/browser/router.js'
)
const { senderMatchesClaimedExtensionId } = await import('../../extension-sender-id-check.js')
const { createApiContext } = await import('../api-context.js')
const { createExtensionPrefsStore } = await import('../../extension-prefs-runner.js')

const OWN = 'a'.repeat(32)
const OTHER = 'b'.repeat(32)

function setup () {
  const extensions = new Map([[OWN, { id: OWN, manifest: { permissions: ['ns-perm'] } }], [OTHER, { id: OTHER, manifest: { permissions: ['ns-perm'] } }]])
  const session = {
    extensions: { on: vi.fn(), getExtension: (id: string) => extensions.get(id) ?? null },
    serviceWorkers: { on: vi.fn() }
  } as unknown as Session
  const router = new ExtensionRouter(session)
  setMessageSenderIdCheck(senderMatchesClaimedExtensionId)
  setPermissionCheck((id: string, permission: string) => id === OWN && permission === 'ns-perm')
  const run = vi.fn(() => 'answer')
  const ctx = createApiContext({
    host: { getRouter: () => router } as never,
    session,
    userDataPath: '/data',
    shell: () => undefined,
    extensions: () => undefined,
    prefs: createExtensionPrefsStore(null),
    held: () => true,
    isAppOrigin: () => false,
    webContentsFromId: () => undefined,
    popupParent: () => undefined
  }, { name: 'ns', permission: 'ns-perm', install: () => {} })
  ctx.handle('ns.read', run)
  return { session, run }
}

function frame (session: Session, url: string) {
  return { type: 'frame', sender: { session }, senderFrame: { url, origin: url.replace(/^([a-z-]+:\/\/[^/]+).*$/, '$1') } }
}

describe('a handler registered through ctx.handle', () => {
  it('answers the extension\'s own page, naming its own id', async () => {
    const { session, run } = setup()
    await expect(handles.get('crx-msg')!(frame(session, `chrome-extension://${OWN}/page.html`), OWN, 'ns.read', 1)).resolves.toBe('answer')
    expect(run).toHaveBeenCalledTimes(1)
    const event = (run.mock.calls[0] as unknown as unknown[])[0] as { type: string, extension: { id: string } }
    expect(event.type).toBe('frame')
    expect(event.extension.id).toBe(OWN)
    expect((run.mock.calls[0] as unknown as unknown[])[1]).toBe(1)
  })

  it('answers the extension\'s own service worker', async () => {
    const { session, run } = setup()
    const event = { type: 'service-worker', serviceWorker: { scope: `chrome-extension://${OWN}/`, ipc: {} }, session }
    await expect(handles.get('crx-msg')!(event, OWN, 'ns.read')).resolves.toBe('answer')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('refuses a web page, whatever extension id it claims', async () => {
    const { session, run } = setup()
    await expect(handles.get('crx-msg')!(frame(session, 'https://evil.example/'), OWN, 'ns.read')).rejects.toThrow(/refused/)
    await expect(handles.get('crx-msg')!(frame(session, 'https://evil.example/'), undefined, 'ns.read')).rejects.toThrow(/refused/)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a content script: it runs in a web page, so its frame is the page\'s', async () => {
    const { session, run } = setup()
    await expect(handles.get('crx-msg')!(frame(session, 'https://news.example/article'), OWN, 'ns.read')).rejects.toThrow(/refused/)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses another extension\'s page claiming this one\'s id, and answers it under its own id only when it holds the permission', async () => {
    const { session, run } = setup()
    await expect(handles.get('crx-msg')!(frame(session, `chrome-extension://${OTHER}/page.html`), OWN, 'ns.read')).rejects.toThrow(/refused/)
    await expect(handles.get('crx-msg')!(frame(session, `chrome-extension://${OTHER}/page.html`), OTHER, 'ns.read')).rejects.toThrow(/requires an extension with ns-perm permissions/)
    expect(run).not.toHaveBeenCalled()
  })

  it('refuses a call with no claimed id', async () => {
    const { session, run } = setup()
    await expect(handles.get('crx-msg')!(frame(session, `chrome-extension://${OWN}/page.html`), undefined, 'ns.read')).rejects.toThrow(/refused/)
    expect(run).not.toHaveBeenCalled()
  })
})
