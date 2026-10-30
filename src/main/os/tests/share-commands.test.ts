import { describe, expect, it, vi } from 'vitest'
import type { ShellWindow } from '../../shell/window-registry.js'
import { copyLinkCommand, copyWebLinkCommand, emailLinkCommand } from '../share-commands.js'
import type { ShareDeps } from '../share-commands.js'

const tabs = [
  { id: 'a', url: 'https://one.example/', displayUrl: 'https://one.example/', title: 'One', isNewTab: false, isInternal: false },
  { id: 'b', url: 'https://two.example/x', displayUrl: 'https://two.example/x', title: 'Two & more', isNewTab: false, isInternal: false },
  { id: 'd', url: 'https://vitalik.eth/blog', displayUrl: 'ipfs://vitalik.eth/blog?a=1#x', title: 'Vitalik', isNewTab: false, isInternal: false },
  { id: 'c', url: 'orivon://settings', displayUrl: 'orivon://settings', title: 'Settings', isNewTab: false, isInternal: true }
]

function setup (active: string, over: Partial<ShareDeps> = {}): { window: ShellWindow, deps: ShareDeps & { writeClipboard: ReturnType<typeof vi.fn>, confirm: ReturnType<typeof vi.fn>, openExternal: ReturnType<typeof vi.fn> }, toasts: () => string[] } {
  const show = vi.fn()
  const window = { window: { id: 'native' }, tabs: { getState: () => ({ tabs, activeTabId: active }) }, overlays: { show } } as unknown as ShellWindow
  const deps = { writeClipboard: vi.fn(async () => {}), confirm: vi.fn(async () => true), openExternal: vi.fn(async () => {}), ...over } as never
  return { window, deps, toasts: () => show.mock.calls.map((call) => (call[2] as { code: string }).code) }
}

describe('Copy link', () => {
  it('copies the address of the tab in front and says so', async () => {
    const { window, deps, toasts } = setup('b')
    await copyLinkCommand(window, deps)
    expect(deps.writeClipboard).toHaveBeenCalledExactlyOnceWith({ text: 'https://two.example/x' })
    expect(toasts()).toEqual(['linkCopied'])
  })

  it('copies the tab it was asked about when that is not the one in front', async () => {
    const { window, deps } = setup('b')
    await copyLinkCommand(window, deps, 'a')
    expect(deps.writeClipboard).toHaveBeenCalledExactlyOnceWith({ text: 'https://one.example/' })
  })

  it('copies the address of a .eth tab as text and as a link another program can follow', async () => {
    const { window, deps, toasts } = setup('d')
    await copyLinkCommand(window, deps)
    expect(deps.writeClipboard).toHaveBeenCalledExactlyOnceWith({
      text: 'ipfs://vitalik.eth/blog?a=1#x',
      html: '<a href="https://vitalik.eth.limo/blog?a=1#x">ipfs://vitalik.eth/blog?a=1#x</a>'
    })
    expect(toasts()).toEqual(['linkCopied'])
  })

  it('copies nothing from a shell page, and says there is no address', async () => {
    const { window, deps, toasts } = setup('c')
    await copyLinkCommand(window, deps)
    expect(deps.writeClipboard).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['noAddress'])
  })

  it('says so when the clipboard refuses, and not before the write is done', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let refuse: (error: Error) => void = () => {}
    const { window, deps, toasts } = setup('a', { writeClipboard: async () => await new Promise<void>((_resolve, reject) => { refuse = reject }) })
    const done = copyLinkCommand(window, deps)
    expect(toasts()).toEqual([])
    refuse(new Error('no clipboard'))
    await expect(done).resolves.toBeUndefined()
    expect(toasts()).toEqual(['linkCopyFailed'])
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })

  it('says the link is copied only after the write is done', async () => {
    let finish: () => void = () => {}
    const { window, deps, toasts } = setup('a', { writeClipboard: async () => await new Promise<void>((resolve) => { finish = resolve }) })
    const done = copyLinkCommand(window, deps)
    expect(toasts()).toEqual([])
    finish()
    await done
    expect(toasts()).toEqual(['linkCopied'])
  })

  it('says so when the clipboard throws at the call', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window, deps, toasts } = setup('a', { writeClipboard: () => { throw new Error('no clipboard') } })
    await expect(copyLinkCommand(window, deps)).resolves.toBeUndefined()
    expect(toasts()).toEqual(['linkCopyFailed'])
    log.mockRestore()
  })
})

describe('Copy web link', () => {
  it('copies the https address another browser opens for a .eth tab, and says so', async () => {
    const { window, deps, toasts } = setup('d')
    await copyWebLinkCommand(window, deps)
    expect(deps.writeClipboard).toHaveBeenCalledExactlyOnceWith({ text: 'https://vitalik.eth.limo/blog?a=1#x' })
    expect(toasts()).toEqual(['webLinkCopied'])
  })

  it('acts on the tab it was asked about, not the one in front', async () => {
    const { window, deps } = setup('a')
    await copyWebLinkCommand(window, deps, 'd')
    expect(deps.writeClipboard).toHaveBeenCalledExactlyOnceWith({ text: 'https://vitalik.eth.limo/blog?a=1#x' })
  })

  it('copies nothing for a web page, which Copy link already copies, or for a shell page', async () => {
    for (const active of ['b', 'c']) {
      const { window, deps, toasts } = setup(active)
      await copyWebLinkCommand(window, deps)
      expect(deps.writeClipboard).not.toHaveBeenCalled()
      expect(toasts()).toEqual(['noWebLink'])
    }
  })

  it('says so when the clipboard refuses', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window, deps, toasts } = setup('d', { writeClipboard: async () => { throw new Error('no clipboard') } })
    await expect(copyWebLinkCommand(window, deps)).resolves.toBeUndefined()
    expect(toasts()).toEqual(['linkCopyFailed'])
    log.mockRestore()
  })
})

describe('Email link', () => {
  it('asks, then hands a mailto address with the title and the address to the mail program', async () => {
    const { window, deps } = setup('b')
    await emailLinkCommand(window, deps)
    expect(deps.confirm).toHaveBeenCalledTimes(1)
    expect(deps.confirm.mock.calls[0]?.[0]).toEqual({ window, tabId: 'b' })
    const question = deps.confirm.mock.calls[0]?.[1] as { scheme: string, url: string, origin: string, initiator?: string }
    expect(question.scheme).toBe('mailto')
    expect(question.initiator).toBe('person')
    expect(question.origin).toBe('https://two.example')
    expect(deps.openExternal).toHaveBeenCalledWith('mailto:?subject=Two%20%26%20more&body=https%3A%2F%2Ftwo.example%2Fx')
    expect(question.url).toBe('mailto:?subject=Two%20%26%20more&body=https%3A%2F%2Ftwo.example%2Fx')
  })

  it('opens nothing when the person says no', async () => {
    const { window, deps } = setup('b', { confirm: async () => false })
    await emailLinkCommand(window, deps)
    expect(deps.openExternal).not.toHaveBeenCalled()
  })

  it('refuses a page with no address before asking anything', async () => {
    const { window, deps, toasts } = setup('c')
    await emailLinkCommand(window, deps)
    expect(deps.confirm).not.toHaveBeenCalled()
    expect(deps.openExternal).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['noAddress'])
  })

  it('does not throw when the mail program cannot be started', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { window, deps, toasts } = setup('a', { openExternal: async () => { throw new Error('no handler') } })
    await expect(emailLinkCommand(window, deps)).resolves.toBeUndefined()
    expect(toasts()).toEqual(['mailFailed'])
    log.mockRestore()
  })
})
