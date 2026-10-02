import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))
const { tabWebPreferences } = await import('../tab-view.js')

describe('every tab\'s webPreferences', () => {
  const prefs = tabWebPreferences('/preload/app.js', undefined)

  it('keeps the page sandboxed and apart from Node', () => {
    expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
  })

  it('runs the preload in the page\'s frames so a frame\'s own dialog reaches the panel', () => {
    expect(prefs.nodeIntegrationInSubFrames).toBe(true)
  })

  it('answers at once a dialog the wrapper never reaches, so no native box is ever drawn', () => {
    expect(prefs.disableDialogs).toBe(true)
  })

  it('is the same for a popup\'s own and an app\'s tab', () => {
    const app = tabWebPreferences('/preload/app.js', 'persist:x', ['--orivon-app-tab'])
    expect(app).toMatchObject({ nodeIntegrationInSubFrames: true, disableDialogs: true, sandbox: true, nodeIntegration: false })
  })
})
