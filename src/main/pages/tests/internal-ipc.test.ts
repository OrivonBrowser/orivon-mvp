import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron'

const handlers = new Map<string, (event: unknown, envelope: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn((channel: string, fn: (event: unknown, envelope: unknown) => unknown) => { handlers.set(channel, fn) }) }
}))

const { authorizeCall, registerInternalIpc } = await import('../internal-ipc.js')
const { InternalPageRegistry } = await import('../internal-registry.js')
const { INTERNAL_COMMAND_CHANNEL, INTERNAL_EVENT_CHANNEL } = await import('../../channels.js')

const OK = { isTopFrame: true, frameUrl: 'orivon://settings/privacy', registeredAs: 'settings' as const, inInternalSession: true }

describe('authorizeCall', () => {
  it('names the page for a top frame the shell opened, on that page\'s own address, in the internal session', () => {
    expect(authorizeCall(OK)).toBe('settings')
  })

  it.each([
    ['a subframe', { ...OK, isTopFrame: false }],
    ['outside the internal session', { ...OK, inInternalSession: false }],
    ['contents the shell never opened as an internal page', { ...OK, registeredAs: undefined }],
    ['another internal page\'s address', { ...OK, frameUrl: 'orivon://history/' }],
    ['a page that has navigated to a website', { ...OK, frameUrl: 'https://settings.example/' }],
    ['a look-alike host', { ...OK, frameUrl: 'orivon://settings.evil/' }],
    ['a scheme that only resembles it', { ...OK, frameUrl: 'orivon-x://settings/' }],
    ['no address at all', { ...OK, frameUrl: '' }],
    ['an unparseable address', { ...OK, frameUrl: 'not a url' }]
  ])('refuses %s', (_name, facts) => {
    expect(authorizeCall(facts)).toBeNull()
  })
})

function fakeContents (id: number): WebContents & EventEmitter {
  const emitter = new EventEmitter() as WebContents & EventEmitter
  Object.assign(emitter, { id, isDestroyed: () => false, send: vi.fn(), mainFrame: { url: '' } })
  return emitter
}

describe('InternalPageRegistry', () => {
  it('knows the contents it opened as a page, and forgets them when they go', () => {
    const registry = new InternalPageRegistry()
    const contents = fakeContents(7)
    registry.register(contents, 'history')

    expect(registry.pageOf(contents)).toBe('history')
    contents.emit('destroyed')
    expect(registry.pageOf(contents)).toBeUndefined()
  })

  it('does not take another webContents for a registered one that shares its id', () => {
    const registry = new InternalPageRegistry()
    registry.register(fakeContents(7), 'history')

    expect(registry.pageOf(fakeContents(7))).toBeUndefined()
  })

  it('publishes a topic to the open pages that asked for it and no others', () => {
    const registry = new InternalPageRegistry()
    const settings = fakeContents(1)
    const history = fakeContents(2)
    registry.register(settings, 'settings')
    registry.register(history, 'history')

    registry.publish('settings.changed', { key: 'k' }, ['settings'])

    expect(settings.send).toHaveBeenCalledExactlyOnceWith(INTERNAL_EVENT_CHANNEL, { topic: 'settings.changed', payload: { key: 'k' } })
    expect(history.send).not.toHaveBeenCalled()
  })
})

describe('registerInternalIpc', () => {
  const session = {} as Session

  function callFrom (contents: WebContents, frameUrl: string, envelope: unknown, sessionOf: Session = session): unknown {
    const handler = handlers.get(INTERNAL_COMMAND_CHANNEL)
    if (handler === undefined) throw new Error('nothing registered')
    const event = { senderFrame: { url: frameUrl }, sender: Object.assign(contents, { session: sessionOf }) } as unknown as IpcMainInvokeEvent
    ;(contents as unknown as { mainFrame: unknown }).mainFrame = event.senderFrame
    return handler(event, envelope)
  }

  function setup (): { contents: WebContents, handle: ReturnType<typeof vi.fn> } {
    const registry = new InternalPageRegistry()
    const contents = fakeContents(1)
    registry.register(contents, 'settings')
    const handle = vi.fn(() => 'answer')
    registerInternalIpc(registry, () => session, {
      settings: { pages: ['settings'], handle },
      history: { pages: ['history'], handle: () => 'history answer' }
    })
    return { contents, handle }
  }

  it('routes a command to its domain with the caller the shell knows', async () => {
    const { contents, handle } = setup()

    expect(await callFrom(contents, 'orivon://settings/', { domain: 'settings', command: { type: 'get' } })).toBe('answer')
    expect(handle).toHaveBeenCalledWith({ type: 'get' }, { page: 'settings', contents })
  })

  it('refuses a domain the page is not allowed, one that does not exist, and a prototype name', async () => {
    const { contents, handle } = setup()

    expect(await callFrom(contents, 'orivon://settings/', { domain: 'history', command: {} })).toBeUndefined()
    expect(await callFrom(contents, 'orivon://settings/', { domain: 'nope', command: {} })).toBeUndefined()
    expect(await callFrom(contents, 'orivon://settings/', { domain: 'toString', command: {} })).toBeUndefined()
    expect(await callFrom(contents, 'orivon://settings/', { domain: '__proto__', command: {} })).toBeUndefined()
    expect(handle).not.toHaveBeenCalled()
  })

  it('refuses a malformed call and a caller outside the internal session', async () => {
    const { contents, handle } = setup()

    for (const envelope of [undefined, null, 'settings', 5, {}, { domain: 5 }]) {
      expect(await callFrom(contents, 'orivon://settings/', envelope)).toBeUndefined()
    }
    expect(await callFrom(contents, 'orivon://settings/', { domain: 'settings', command: {} }, {} as Session)).toBeUndefined()
    expect(handle).not.toHaveBeenCalled()
  })

  it('refuses a call from a page that has left its address', async () => {
    const { contents, handle } = setup()

    expect(await callFrom(contents, 'https://example.com/', { domain: 'settings', command: {} })).toBeUndefined()
    expect(handle).not.toHaveBeenCalled()
  })
})
