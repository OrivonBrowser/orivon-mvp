// ipcRenderer/ipcMain, backed by a local in-sandbox message bus rather than
// the broker. ADR-0005 dissolved the app backend: all app code is renderer
// JavaScript, so "main" and "renderer" are the SAME realm here, and no
// capability or grant is involved at all -- this is a same-realm event and
// request registry, not IPC in the OS sense. Do not add a broker call to
// anything in this file; that is the mistake this design exists to prevent.

import { refuse } from './errors.js'

export type IpcListener = (event: IpcEvent, ...args: readonly unknown[]) => void
export type IpcHandler = (event: IpcEvent, ...args: readonly unknown[]) => unknown

/**
 * Real Electron's event carries the sender's process/frame identity, because
 * main and renderer are different processes there. There is exactly one
 * realm here, so this is a stub with no real fields to report -- present so
 * a handler's `(event, ...args)` shape still matches real Electron's.
 */
export interface IpcEvent { readonly senderId: null }

const EVENT: IpcEvent = { senderId: null }

export interface ElectronIpcRenderer {
  invoke(channel: string, ...args: readonly unknown[]): Promise<unknown>
  send(channel: string, ...args: readonly unknown[]): void
  on(channel: string, listener: IpcListener): void
  once(channel: string, listener: IpcListener): void
  removeListener(channel: string, listener: IpcListener): void
  removeAllListeners(channel: string): void
}

export interface ElectronIpcMain {
  handle(channel: string, handler: IpcHandler): void
  handleOnce(channel: string, handler: IpcHandler): void
  removeHandler(channel: string): void
  on(channel: string, listener: IpcListener): void
  once(channel: string, listener: IpcListener): void
  removeListener(channel: string, listener: IpcListener): void
  removeAllListeners(channel: string): void
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

  function removeAllListeners (channel: string): void {
    listeners.delete(channel)
  }

  function once (channel: string, listener: IpcListener): void {
    const wrapped: IpcListener = (event, ...args) => {
      removeListener(channel, wrapped)
      listener(event, ...args)
    }
    on(channel, wrapped)
  }

  function send (channel: string, ...args: readonly unknown[]): void {
    for (const listener of listeners.get(channel) ?? []) listener(EVENT, ...args)
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
    return await handler(EVENT, ...args)
  }

  return {
    ipcRenderer: { invoke, send, on, once, removeListener, removeAllListeners },
    ipcMain: { handle, handleOnce, removeHandler, on, once, removeListener, removeAllListeners }
  }
}
