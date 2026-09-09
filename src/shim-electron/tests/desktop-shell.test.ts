import { describe, expect, it } from 'vitest'
import { BrowserWindow, Menu, Tray } from '../desktop-shell.js'
import { ElectronShimError } from '../errors.js'

describe('desktop-shell refusals', () => {
  it('BrowserWindow throws a named desktop-shell error on construction', () => {
    expect(() => new BrowserWindow()).toThrow(ElectronShimError)
    try {
      // eslint-disable-next-line no-new
      new BrowserWindow()
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('desktop-shell')
      expect((error as ElectronShimError).api).toBe('BrowserWindow')
    }
  })

  it('BrowserWindow.getAllWindows and getFocusedWindow refuse the same way', () => {
    expect(() => BrowserWindow.getAllWindows()).toThrow(ElectronShimError)
    expect(() => BrowserWindow.getFocusedWindow()).toThrow(ElectronShimError)
  })

  it('Menu throws on construction and on its common static entry points', () => {
    expect(() => new Menu()).toThrow(ElectronShimError)
    expect(() => Menu.buildFromTemplate([])).toThrow(ElectronShimError)
    expect(() => Menu.setApplicationMenu(null)).toThrow(ElectronShimError)
    expect(() => Menu.getApplicationMenu()).toThrow(ElectronShimError)
  })

  it('Tray throws a named desktop-shell error on construction', () => {
    expect(() => new Tray()).toThrow(ElectronShimError)
    try {
      // eslint-disable-next-line no-new
      new Tray()
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('desktop-shell')
    }
  })

  it('every refusal names an app running inside its own tab as the reason, not a generic message', () => {
    try {
      // eslint-disable-next-line no-new
      new BrowserWindow()
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as ElectronShimError).message).toMatch(/tab/i)
    }
  })
})
