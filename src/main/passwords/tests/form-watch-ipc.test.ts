import { describe, expect, it, vi } from 'vitest'
import type { IpcMainEvent, WebContents } from 'electron'
import { FORM_FILL_CHANNEL, FORM_WATCH_CHANNEL } from '../../channels.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { createFormWatch, fillFrame, installFormWatchIpc, MESSAGES_PER_SECOND } from '../form-watch-ipc.js'
import type { FormSender } from '../form-watch-ipc.js'

interface Rig {
  send: (payload: unknown, over?: { frame?: unknown, tab?: boolean, sender?: unknown }) => void
  seen: Array<{ message: unknown, sender: FormSender }>
  remove: () => void
  registered: () => number
}

function rig (allow?: (key: number) => boolean): Rig {
  const window = { name: 'window' } as unknown as ShellWindow
  const mainFrame = { url: 'https://site.example/login?next=1' }
  const sender = { id: 7, mainFrame }
  const listeners = new Set<(event: IpcMainEvent, payload: unknown) => void>()
  const ipc = {
    on: (channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => { expect(channel).toBe(FORM_WATCH_CHANNEL); listeners.add(listener) },
    removeListener: (_channel: string, listener: (event: IpcMainEvent, payload: unknown) => void) => { listeners.delete(listener) }
  }
  const windows = { findTab: (contents: unknown) => contents === sender ? { window, tabId: 't1' } : null }
  const watch = createFormWatch()
  const seen: Rig['seen'] = []
  for (const type of ['hello', 'fields', 'focus', 'submit'] as const) watch.on(type, (message, from) => { seen.push({ message, sender: from }) })
  const remove = installFormWatchIpc(ipc, windows, watch, allow)
  return {
    seen,
    remove,
    registered: () => listeners.size,
    send: (payload, over = {}) => {
      const frame = 'frame' in over ? over.frame : mainFrame
      const from = 'sender' in over ? over.sender : sender
      for (const listener of listeners) listener({ sender: from, senderFrame: frame } as unknown as IpcMainEvent, payload)
    }
  }
}

describe('installFormWatchIpc', () => {
  it('delivers a message from the top frame of a tab, with the origin read from the frame', () => {
    const { send, seen } = rig()
    send({ type: 'submit', username: 'ada', password: 'pw', origin: 'https://evil.example' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.message).toEqual({ type: 'submit', username: 'ada', password: 'pw' })
    expect(seen[0]?.sender).toMatchObject({ tabId: 't1', origin: 'https://site.example' })
  })

  it('ignores a sender that is not a tab of a shell window', () => {
    const { send, seen } = rig()
    const other = { id: 9, mainFrame: { url: 'https://site.example/' } }
    send({ type: 'hello' }, { sender: other, frame: other.mainFrame })
    expect(seen).toEqual([])
  })

  it('ignores a subframe, and a message with no frame', () => {
    const { send, seen } = rig()
    send({ type: 'hello' }, { frame: { url: 'https://site.example/login' } })
    send({ type: 'hello' }, { frame: null })
    expect(seen).toEqual([])
  })

  it('ignores a top frame that is not http or https', () => {
    for (const url of ['file:///etc/passwd', 'orivon://settings/', 'chrome-extension://abc/page.html', 'about:blank', 'data:text/html,x', '']) {
      const window = {} as unknown as ShellWindow
      const frame = { url }
      const sender = { id: 1, mainFrame: frame }
      let listener: ((event: IpcMainEvent, payload: unknown) => void) | undefined
      const watch = createFormWatch()
      const handler = vi.fn()
      watch.on('hello', handler)
      installFormWatchIpc({ on: (_c, l) => { listener = l }, removeListener: () => {} }, { findTab: () => ({ window, tabId: 't' }) }, watch)
      listener?.({ sender, senderFrame: frame } as unknown as IpcMainEvent, { type: 'hello' })
      expect(handler, url).not.toHaveBeenCalled()
    }
  })

  it('ignores a payload that is not a message', () => {
    const { send, seen } = rig()
    send('hello')
    send({ type: 'nope' })
    send({ type: 'submit', username: 'a', password: '' })
    send({ type: 'submit', username: 'a'.repeat(300), password: 'x' })
    expect(seen).toEqual([])
  })

  it('lets a tab send its limit a second and drops the rest', () => {
    const { send, seen } = rig(undefined)
    for (let i = 0; i < MESSAGES_PER_SECOND + 5; i++) send({ type: 'hello' })
    expect(seen).toHaveLength(MESSAGES_PER_SECOND)
  })

  it('takes the limit from its own key, the sender\'s id', () => {
    const keys: number[] = []
    const { send } = rig((key) => { keys.push(key); return true })
    send({ type: 'hello' })
    expect(keys).toEqual([7])
  })

  it('stops listening when removed', () => {
    const { send, seen, remove, registered } = rig()
    expect(registered()).toBe(1)
    remove()
    expect(registered()).toBe(0)
    send({ type: 'hello' })
    expect(seen).toEqual([])
  })
})

describe('createFormWatch', () => {
  it('runs every handler of a type, and a throwing one does not stop the rest', () => {
    const watch = createFormWatch()
    const order: string[] = []
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    watch.on('hello', () => { throw new Error('boom') })
    watch.on('hello', () => { order.push('second') })
    watch.on('fields', () => { order.push('other type') })
    watch.dispatch({ type: 'hello' }, {} as FormSender)
    expect(order).toEqual(['second'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('removes a handler', () => {
    const watch = createFormWatch()
    const handler = vi.fn()
    const off = watch.on('hello', handler)
    off()
    watch.dispatch({ type: 'hello' }, {} as FormSender)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('fillFrame', () => {
  const contents = (url: string, extra: Partial<{ destroyed: boolean, send: () => void }> = {}): { wc: WebContents, send: ReturnType<typeof vi.fn> } => {
    const send = vi.fn(extra.send)
    return { wc: { isDestroyed: () => extra.destroyed === true, mainFrame: { url, send } } as unknown as WebContents, send }
  }
  const command = { type: 'fill', username: 'ada', password: 'pw', both: false } as const

  it('sends the command to the top frame while it is still at the origin', () => {
    const { wc, send } = contents('https://site.example/login')
    expect(fillFrame(wc, 'https://site.example', command)).toBe(true)
    expect(send).toHaveBeenCalledWith(FORM_FILL_CHANNEL, command)
  })

  it('sends nothing to a page that moved to another origin, another scheme or another port', () => {
    for (const url of ['https://evil.example/', 'http://site.example/', 'https://site.example:8443/', 'about:blank']) {
      const { wc, send } = contents(url)
      expect(fillFrame(wc, 'https://site.example', command), url).toBe(false)
      expect(send, url).not.toHaveBeenCalled()
    }
  })

  it('sends nothing to a destroyed page, and does not throw when the frame is gone', () => {
    const gone = contents('https://site.example/', { destroyed: true })
    expect(fillFrame(gone.wc, 'https://site.example', command)).toBe(false)
    const broken = contents('https://site.example/', { send: () => { throw new Error('frame disposed') } })
    expect(fillFrame(broken.wc, 'https://site.example', command)).toBe(false)
  })
})
