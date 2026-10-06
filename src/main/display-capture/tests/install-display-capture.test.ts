import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  ipcHandlers: new Map<string, unknown>(),
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  desktopCapturer: { getSources: vi.fn(async () => await Promise.resolve([])) },
  webContents: { fromFrame: vi.fn(), getAllWebContents: vi.fn((): unknown[] => []) }
}))
vi.mock('electron', () => electron)
vi.mock('../../shell/showing-window.js', () => ({ windowShowing: () => ({}) }))

const { installDisplayCapture } = await import('../install-display-capture.js')
const { siteAsks } = await import('../../sessions/site-asks.js')
const { handleDisplayMedia } = await import('../../sessions/display-media-handler.js')
const { shareRegistry } = await import('../bindings.js')

const SITE = 'https://share.example'

function tab (): never {
  return { id: 1, mainFrame: { processId: 10, routingId: 2, url: `${SITE}/page` }, isDestroyed: () => false, getURL: () => `${SITE}/page` } as never
}

describe('installDisplayCapture', () => {
  it('registers its asker ahead of one added earlier, so the display request never reaches the general rules', async () => {
    siteAsks.add({ name: 'general', request: async () => await Promise.resolve(true), check: () => true })
    const app = new EventEmitter()
    installDisplayCapture.install(app as never, { windows: { findTab: () => ({}) }, settings: { get: () => 'ask' }, siteSettings: { get: () => undefined } } as never, {} as never, {} as never)
    const details = { mediaTypes: [], isMainFrame: true, securityOrigin: SITE }
    // No ticket is open, so the display asker refuses; the general asker would have granted.
    expect(await siteAsks.request(tab(), 'media', details)).toBe(false)
    // The general asker still answers what the display asker does not own.
    expect(await siteAsks.request(tab(), 'media', { ...details, mediaTypes: ['video'] })).toBe(true)
    expect(siteAsks.check(tab(), 'display-capture', SITE, { isMainFrame: true })).toBe(true)
  })

  it('binds the display handler and the share registry, and listens on the pick and report channels', async () => {
    const answers: object[] = []
    handleDisplayMedia({ frame: null, securityOrigin: SITE, videoRequested: true, audioRequested: false, userGesture: true }, (streams) => answers.push(streams))
    expect(answers).toEqual([{}])
    expect(shareRegistry().list()).toEqual([])
    expect(electron.ipcMain.handle).toHaveBeenCalledWith('orivon-display-capture:pick', expect.any(Function))
    expect(electron.ipcMain.on).toHaveBeenCalledWith('orivon-display-capture:report', expect.any(Function))
  })

  it('answers the display permission false when sharing is blocked by default', () => {
    // Another install over the same registry: the newest asker added first answers first.
    const app = new EventEmitter()
    installDisplayCapture.install(app as never, { windows: { findTab: () => ({}) }, settings: { get: () => 'block' }, siteSettings: { get: () => undefined } } as never, {} as never, {} as never)
    expect(siteAsks.check(tab(), 'display-capture', SITE, { isMainFrame: true })).toBe(false)
  })

  it('treats a registered app with no grants as an app: its display permission is refused, as the app media asker would', () => {
    const app = new EventEmitter()
    const ctx = { broker: { app: { isRegisteredSync: () => true, hasGrantsSync: () => false } } }
    installDisplayCapture.install(app as never, { windows: { findTab: () => ({}) }, settings: { get: () => 'ask' }, siteSettings: { get: () => undefined } } as never, ctx as never, {} as never)
    expect(siteAsks.check(tab(), 'display-capture', SITE, { isMainFrame: true })).toBe(false)
  })

  it('ends a tab\'s ticket and picker when its page is destroyed, replaced or loses its renderer, and forgets suspicion when a document commits', () => {
    const page = Object.assign(new EventEmitter(), tab() as object)
    electron.webContents.getAllWebContents.mockReturnValueOnce([page])
    const app = new EventEmitter()
    installDisplayCapture.install(app as never, { windows: { findTab: () => ({}) }, settings: { get: () => 'ask' }, siteSettings: { get: () => undefined } } as never, {} as never, {} as never)
    for (const event of ['destroyed', 'render-process-gone', 'did-start-navigation', 'did-navigate']) expect(page.listenerCount(event)).toBe(1)
    expect(() => { page.emit('destroyed'); page.emit('did-navigate') }).not.toThrow()
    const later = Object.assign(new EventEmitter(), tab() as object)
    app.emit('web-contents-created', {}, later)
    expect(later.listenerCount('destroyed')).toBe(1)
  })
})
