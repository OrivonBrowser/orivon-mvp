// ipcRenderer/ipcMain, backed by a local in-sandbox message bus rather than
// the broker. ADR-0005 dissolved the app backend: all app code runs in the
// renderer, so "main" and "renderer" are the SAME realm here, and no
// capability or grant is involved at all -- this is a same-realm event and
// request registry, not IPC in the OS sense. Do not add a broker call to
// anything in this file; that is the mistake this design exists to prevent.

import { refuse } from './errors.js'

export type IpcListener = (event: IpcEvent, ...args: readonly unknown[]) => void
export type IpcHandler = (event: IpcEvent, ...args: readonly unknown[]) => unknown

/**
 * Real Electron's event carries the sender's process/frame identity, because
 * main and renderer are different processes there. There is exactly one
 * realm here, so `senderId` is a stub with no real value to report -- present
 * so a handler's `(event, ...args)` shape still matches real Electron's.
 * `returnValue` is what a listener sets to answer `ipcRenderer.sendSync`.
 */
export interface IpcEvent { readonly senderId: null, returnValue: unknown }

/** A fresh event per dispatch: a `returnValue` one call set must never answer the next. */
const newEvent = (): IpcEvent => ({ senderId: null, returnValue: undefined })

export interface ElectronIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>
  send(channel: string, ...args: readonly unknown[]): void
  sendSync(channel: string, ...args: readonly unknown[]): unknown
  on(channel: string, listener: IpcListener): this
  once(channel: string, listener: IpcListener): this
  addListener(channel: string, listener: IpcListener): this
  off(channel: string, listener: IpcListener): this
  removeListener(channel: string, listener: IpcListener): this
  removeAllListeners(channel?: string): this
}

export interface ElectronIpcMain {
  handle(channel: string, handler: IpcHandler): void
  handleOnce(channel: string, handler: IpcHandler): void
  removeHandler(channel: string): void
  on(channel: string, listener: IpcListener): this
  once(channel: string, listener: IpcListener): this
  addListener(channel: string, listener: IpcListener): this
  off(channel: string, listener: IpcListener): this
  removeListener(channel: string, listener: IpcListener): this
  removeAllListeners(channel?: string): this
}

export function createIpc (): { ipcRenderer: ElectronIpcRenderer, ipcMain: ElectronIpcMain } {
  const handlers = new Map<string, IpcHandler>()
  const listeners = new Map<string, Set<IpcListener>>()

  function on (channel: string, listener: IpcListener): void {
    let set = listeners.get(channel)
    if (set === undefined) {
      set = new Set()
      listeners.set(channel, set)
    }
    set.add(listener)
  }

  function removeListener (channel: string, listener: IpcListener): void {
    listeners.get(channel)?.delete(listener)
  }

  function removeAllListeners (channel?: string): void {
    if (channel === undefined) listeners.clear()
    else listeners.delete(channel)
  }

  function once (channel: string, listener: IpcListener): void {
    const wrapped: IpcListener = (event, ...args) => {
      removeListener(channel, wrapped)
      return listener(event, ...args)
    }
    on(channel, wrapped)
  }

  function send (channel: string, ...args: readonly unknown[]): void {
    for (const listener of [...listeners.get(channel) ?? []]) listener(newEvent(), ...args)
  }

  /**
   * Runs the channel's listeners to completion and answers with the `returnValue` one of them set. Whether one set it
   * is read off an accessor, because `undefined` is a legitimate answer. See README.md's Design notes for the refusals.
   */
  function sendSync (channel: string, ...args: readonly unknown[]): unknown {
    const api = `ipcRenderer.sendSync('${channel}')`
    const registered = [...listeners.get(channel) ?? []]
    if (registered.length === 0) {
      throw refuse(api, 'invalid-usage',
        `no ipcMain.on('${channel}', ...) listener is registered. Register one before calling sendSync; it answers by setting event.returnValue.`)
    }
    let answered = false
    let answer: unknown
    let promised = false
    const event: IpcEvent = {
      senderId: null,
      get returnValue () { return answer },
      set returnValue (value: unknown) { answered = true; answer = value }
    }
    for (const listener of registered) {
      const returned: unknown = listener(event, ...args)
      if (typeof (returned as { then?: unknown } | null)?.then === 'function') promised = true
    }
    if (!answered) {
      throw refuse(api, 'invalid-usage', promised
        ? `the listener on '${channel}' is async and returned before setting event.returnValue; sendSync is answered ` +
          'synchronously, so set event.returnValue before the first await, or call ipcRenderer.invoke instead.'
        : `no listener on '${channel}' set event.returnValue. Set it (to undefined, for an empty answer) before the listener returns.`)
    }
    return answer
  }

  /** Same restriction as real Electron: one handler per channel, replaced only via removeHandler first. */
  function handle (channel: string, handler: IpcHandler): void {
    if (handlers.has(channel)) {
      throw refuse(`ipcMain.handle('${channel}')`, 'invalid-usage',
        `a handler is already registered for '${channel}' -- call ipcMain.removeHandler('${channel}') ` +
        'first, or use a different channel name.')
    }
    handlers.set(channel, handler)
  }

  function handleOnce (channel: string, handler: IpcHandler): void {
    handle(channel, (event, ...args) => {
      handlers.delete(channel)
      return handler(event, ...args)
    })
  }

  function removeHandler (channel: string): void {
    handlers.delete(channel)
  }

  async function invoke (channel: string, ...args: readonly unknown[]): Promise<unknown> {
    const handler = handlers.get(channel)
    if (handler === undefined) {
      throw refuse(`ipcRenderer.invoke('${channel}')`, 'invalid-usage',
        `no ipcMain.handle('${channel}', ...) is registered. Register a handler before invoking it.`)
    }
    return await handler(newEvent(), ...args)
  }

  const ipcRenderer: ElectronIpcRenderer = {
    invoke,
    send,
    sendSync,
    on: (channel, listener) => { on(channel, listener); return ipcRenderer },
    once: (channel, listener) => { once(channel, listener); return ipcRenderer },
    addListener: (channel, listener) => { on(channel, listener); return ipcRenderer },
    off: (channel, listener) => { removeListener(channel, listener); return ipcRenderer },
    removeListener: (channel, listener) => { removeListener(channel, listener); return ipcRenderer },
    removeAllListeners: (channel) => { removeAllListeners(channel); return ipcRenderer }
  }
  const ipcMain: ElectronIpcMain = {
    handle,
    handleOnce,
    removeHandler,
    on: (channel, listener) => { on(channel, listener); return ipcMain },
    once: (channel, listener) => { once(channel, listener); return ipcMain },
    addListener: (channel, listener) => { on(channel, listener); return ipcMain },
    off: (channel, listener) => { removeListener(channel, listener); return ipcMain },
    removeListener: (channel, listener) => { removeListener(channel, listener); return ipcMain },
    removeAllListeners: (channel) => { removeAllListeners(channel); return ipcMain }
  }
  return { ipcRenderer, ipcMain }
}
