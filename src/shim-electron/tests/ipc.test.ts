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

describe('ipcRenderer.sendSync', () => {
  it('answers with the returnValue a listener set while it ran', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.on('store-get', (event, key: unknown) => { event.returnValue = { key, value: 7 } })
    expect(ipcRenderer.sendSync('store-get', 'a')).toEqual({ key: 'a', value: 7 })
  })

  it('treats a returnValue explicitly set to undefined as an answer', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.on('nothing', (event) => { event.returnValue = undefined })
    expect(ipcRenderer.sendSync('nothing')).toBeUndefined()
  })

  it('refuses by name when no listener is registered on the channel', () => {
    const { ipcRenderer } = createIpc()
    expect(() => ipcRenderer.sendSync('missing')).toThrow(ElectronShimError)
    try { ipcRenderer.sendSync('missing') } catch (error) {
      expect((error as ElectronShimError).reason).toBe('invalid-usage')
      expect((error as ElectronShimError).api).toBe("ipcRenderer.sendSync('missing')")
    }
  })

  it('refuses by name when listeners ran and none set returnValue', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const listener = vi.fn()
    ipcMain.on('silent', listener)
    expect(() => ipcRenderer.sendSync('silent')).toThrow(ElectronShimError)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('says an async listener cannot answer when it returns a promise and sets nothing synchronously', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.on('late', (async (event: { returnValue: unknown }) => { await Promise.resolve(); event.returnValue = 1 }) as never)
    expect(() => ipcRenderer.sendSync('late')).toThrow(/async|promise/i)
  })

  it('gives every call a fresh event, so one call\'s returnValue never answers the next', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    let first = true
    ipcMain.on('once-set', (event) => { if (first) { first = false; event.returnValue = 1 } })
    expect(ipcRenderer.sendSync('once-set')).toBe(1)
    expect(() => ipcRenderer.sendSync('once-set')).toThrow(ElectronShimError)
  })

  it('runs a once() listener a single time', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    ipcMain.once('one', (event) => { event.returnValue = 'x' })
    expect(ipcRenderer.sendSync('one')).toBe('x')
    expect(() => ipcRenderer.sendSync('one')).toThrow(ElectronShimError)
  })
})

describe('listener registration returns the emitter, as Electron\'s do', () => {
  it('on, once, addListener, off, removeListener and removeAllListeners chain on ipcMain and ipcRenderer', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const fn = vi.fn()
    for (const bus of [ipcMain, ipcRenderer]) {
      expect(bus.on('c', fn)).toBe(bus)
      expect(bus.once('c', fn)).toBe(bus)
      expect(bus.addListener('c', fn)).toBe(bus)
      expect(bus.off('c', fn)).toBe(bus)
      expect(bus.removeListener('c', fn)).toBe(bus)
      expect(bus.removeAllListeners('c')).toBe(bus)
    }
  })

  it('off removes the listener addListener added', () => {
    const { ipcRenderer, ipcMain } = createIpc()
    const fn = vi.fn()
    ipcMain.addListener('c', fn).off('c', fn)
    ipcRenderer.send('c')
    expect(fn).not.toHaveBeenCalled()
  })
})
