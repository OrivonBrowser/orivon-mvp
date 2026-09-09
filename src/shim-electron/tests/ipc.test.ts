import { describe, expect, it, vi } from 'vitest'
import { createIpc } from '../ipc.js'
import { ElectronShimError } from '../errors.js'

describe('createIpc', () => {
  it('resolves ipcRenderer.invoke with the value ipcMain.handle\'s handler returns', async () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.handle('ping', async (_event, name: unknown) => `pong ${String(name)}`)
    await expect(ipcRenderer.invoke('ping', 'a')).resolves.toBe('pong a')
  })

  it('rejects ipcRenderer.invoke with a named error when no handler is registered', async () => {
    const { ipcRenderer } = createIpc()
    await expect(ipcRenderer.invoke('missing')).rejects.toThrow(ElectronShimError)
  })

  it('throws a named error registering a second handler for the same channel', () => {
    const { ipcMain } = createIpc()
    ipcMain.handle('x', () => 1)
    expect(() => ipcMain.handle('x', () => 2)).toThrow(ElectronShimError)
  })

  it('lets removeHandler free the channel for a fresh handle', () => {
    const { ipcMain } = createIpc()
    ipcMain.handle('x', () => 1)
    ipcMain.removeHandler('x')
    expect(() => ipcMain.handle('x', () => 2)).not.toThrow()
  })

  it('handleOnce answers exactly one invoke, then behaves as unregistered', async () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.handleOnce('once', () => 'first')
    await expect(ipcRenderer.invoke('once')).resolves.toBe('first')
    await expect(ipcRenderer.invoke('once')).rejects.toThrow(ElectronShimError)
  })

  it('delivers ipcRenderer.send to every ipcMain.on listener on that channel', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const listener = vi.fn()
    ipcMain.on('event', listener)
    ipcRenderer.send('event', 1, 2)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.slice(1)).toEqual([1, 2])
  })

  it('once() fires a listener exactly one time', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const listener = vi.fn()
    ipcMain.once('event', listener)
    ipcRenderer.send('event')
    ipcRenderer.send('event')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('removeListener stops a specific listener without touching others', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const a = vi.fn()
    const b = vi.fn()
    ipcMain.on('event', a)
    ipcMain.on('event', b)
    ipcMain.removeListener('event', a)
    ipcRenderer.send('event')
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })

  it('removeAllListeners clears every listener on a channel', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const listener = vi.fn()
    ipcMain.on('event', listener)
    ipcMain.removeAllListeners('event')
    ipcRenderer.send('event')
    expect(listener).not.toHaveBeenCalled()
  })
})
