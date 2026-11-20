import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabOpenerHost } from '../tab-open.js'
import type { TabFactory } from '../tab-factory.js'

const fuse = vi.hoisted(() => ({ known: 'off' as 'off' | 'on' | 'unknown' | undefined }))
vi.mock('../../local-files/file-fuse.js', () => ({
  knownFileProtocolFuse: () => fuse.known,
  fileProtocolFuse: () => Promise.resolve(fuse.known)
}))

const FILE = 'file:///home/u/notes/app.html'

/** A fresh gate and a fresh opener over it: the gate's state lasts as long as its module. */
async function setup (capacity = false) {
  vi.resetModules()
  const gate = await import('../../startup/web-ready.js')
  const { TabOpener } = await import('../tab-open.js')
  const add = vi.fn()
  const contents = { loadURL: vi.fn(() => Promise.resolve()) }
  const host: TabOpenerHost = { add, activate: vi.fn(), changed: vi.fn(), atCapacity: () => capacity, activeId: () => 'front', records: () => [] }
  const built = { id: 't1', target: 'https://a.example/', record: { view: { webContents: contents } } }
  const factory = { content: vi.fn((_url?: string, _choice?: string) => built), blob: vi.fn(() => built), trusted: vi.fn(() => built), localFile: vi.fn(() => built), internal: vi.fn(() => built) }
  return { gate, opener: new TabOpener(host, factory as unknown as TabFactory), add, contents, factory }
}

beforeEach(() => { fuse.known = 'off' })

describe('TabOpener before web pages may load', () => {
  it('opens no tab for an address, answers the tab in front, and opens it once the gate opens', async () => {
    const { gate, opener, add, factory, contents } = await setup()
    expect(opener.createTab('https://a.example/')).toBe('front')
    expect(factory.content).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()

    gate.openWebContent()
    await vi.waitFor(() => { expect(add).toHaveBeenCalledOnce() })
    expect(factory.content).toHaveBeenCalledWith('https://a.example/', undefined)
    expect(contents.loadURL).toHaveBeenCalledWith('https://a.example/', undefined)
  })

  it('keeps what a deferred tab was asked: behind, with its form post and its tunnel choice', async () => {
    const { gate, opener, factory, contents } = await setup()
    const post = { postData: [] }
    opener.createTab('https://a.example/', false, post, 'nym')
    gate.openWebContent()
    await vi.waitFor(() => { expect(contents.loadURL).toHaveBeenCalledOnce() })
    expect(factory.content).toHaveBeenCalledWith('https://a.example/', 'nym')
    expect(contents.loadURL).toHaveBeenCalledWith('https://a.example/', post)
  })

  it('opens the new-tab page at once: it is the shell\'s own and loads nothing from the web', async () => {
    const { opener, add, factory } = await setup()
    expect(opener.createTab()).toBe('t1')
    expect(opener.openTrusted()?.[0]).toBe('t1')
    expect(factory.content).toHaveBeenCalledTimes(2)
    expect(add).toHaveBeenCalledTimes(2)
  })

  it('opens one of the shell\'s own pages at once', async () => {
    const { opener, add, factory } = await setup()
    opener.openInternal('settings')
    expect(factory.internal).toHaveBeenCalledOnce()
    expect(add).toHaveBeenCalledOnce()
  })

  it('opens a blob: tab only once the gate opens', async () => {
    const { gate, opener, add, factory } = await setup()
    expect(opener.openBlobTab('blob:https://a.example/1', 'persist:p')).toBe('front')
    expect(factory.blob).not.toHaveBeenCalled()
    gate.openWebContent()
    await vi.waitFor(() => { expect(add).toHaveBeenCalledOnce() })
    expect(factory.blob).toHaveBeenCalledWith('blob:https://a.example/1', 'persist:p', undefined)
  })

  it('opens a trusted caller\'s target only once the gate opens, answering undefined as at the limit', async () => {
    const { gate, opener, add, factory } = await setup()
    expect(opener.openTrusted('https://a.example/', 'persist:p', 'socks5')).toBeUndefined()
    expect(factory.trusted).not.toHaveBeenCalled()
    gate.openWebContent()
    await vi.waitFor(() => { expect(add).toHaveBeenCalledOnce() })
    expect(factory.trusted).toHaveBeenCalledWith('https://a.example/', 'persist:p', 'socks5')
  })

  it('opens a local file only once the gate opens, and answers its id then', async () => {
    const { gate, opener, add } = await setup()
    const opened = opener.openLocalFile(FILE)
    await Promise.resolve()
    expect(add).not.toHaveBeenCalled()
    gate.openWebContent()
    expect(await opened).toBe('t1')
    expect(add).toHaveBeenCalledOnce()
  })

  it('answers undefined, with nothing opened, to a caller that needs a local file\'s id at once', async () => {
    const { opener, add } = await setup()
    expect(opener.openLocalFileNow(FILE)).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
  })

  it('opens what waited in the order it was asked', async () => {
    const { gate, opener, factory } = await setup()
    opener.createTab('https://one.example/')
    opener.createTab('https://two.example/')
    gate.openWebContent()
    await vi.waitFor(() => { expect(factory.content).toHaveBeenCalledTimes(2) })
    expect(factory.content.mock.calls.map((call) => call[0])).toEqual(['https://one.example/', 'https://two.example/'])
  })

  it('opens nothing for a request that waited if the window is full or gone when the gate opens', async () => {
    vi.resetModules()
    const gate = await import('../../startup/web-ready.js')
    const { TabOpener } = await import('../tab-open.js')
    let full = false
    const add = vi.fn()
    const host: TabOpenerHost = { add, activate: vi.fn(), changed: vi.fn(), atCapacity: () => full, activeId: () => 'front', records: () => [] }
    const factory = { content: vi.fn() }
    new TabOpener(host, factory as unknown as TabFactory).createTab('https://a.example/')
    full = true
    gate.openWebContent()
    await Promise.resolve()
    await Promise.resolve()
    expect(factory.content).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
  })
})

describe('TabOpener once web pages may load', () => {
  it('opens every kind of tab at once', async () => {
    const { gate, opener, add, factory } = await setup()
    gate.openWebContent()
    expect(opener.createTab('https://a.example/')).toBe('t1')
    expect(opener.openBlobTab('blob:https://a.example/1', undefined)).toBe('t1')
    expect(opener.openTrusted('https://a.example/')?.[0]).toBe('t1')
    expect(opener.openLocalFileNow(FILE)).toBe('t1')
    expect(await opener.openLocalFile(FILE)).toBe('t1')
    expect(add).toHaveBeenCalledTimes(5)
    expect(factory.content).toHaveBeenCalledTimes(1)
  })

  it('still refuses at the limit, whatever the gate says', async () => {
    const { gate, opener, add } = await setup(true)
    gate.openWebContent()
    expect(opener.createTab('https://a.example/')).toBe('front')
    expect(opener.openTrusted('https://a.example/')).toBeUndefined()
    expect(await opener.openLocalFile(FILE)).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
  })
})
