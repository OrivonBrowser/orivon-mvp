import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ WebContentsView: vi.fn() }))
const { tabWebPreferences } = await import('../tab-view.js')

describe('every tab\'s webPreferences', () => {
  const prefs = tabWebPreferences('/preload/app.js', undefined)

  it('keeps the page sandboxed and apart from Node', () => {
    expect(prefs).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true })
  })

  it('runs the preload in the top frame only, and leaves a page\'s dialogs to Electron\'s dialog event', () => {
    expect(prefs.nodeIntegrationInSubFrames).toBeUndefined()
    expect(prefs.disableDialogs).toBeUndefined()
  })

  it('is the same for a popup\'s own and an app\'s tab', () => {
    const app = tabWebPreferences('/preload/app.js', 'persist:x', ['--orivon-app-tab'])
    expect(app).toMatchObject({ sandbox: true, nodeIntegration: false })
    expect(app.nodeIntegrationInSubFrames).toBeUndefined()
    expect(app.disableDialogs).toBeUndefined()
  })
})
