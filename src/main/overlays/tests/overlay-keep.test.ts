import { describe, expect, it } from 'vitest'
import { findOverlay } from '../../find/find-overlay.js'
import { omniboxOverlay } from '../../omnibox/omnibox-overlay.js'
import { toastOverlayFor } from '../../page-tools/toast-overlay.js'
import { menuOverlay } from '../../shell/menu-overlay.js'
import { sidePanelOverlay } from '../../side-panel/side-panel-overlay.js'

describe('which overlays keep their renderer', () => {
  it('keeps the address bar\'s suggestions for the life of the window, because typing never waits for a renderer', () => {
    expect(omniboxOverlay.keep).toBe('resident')
  })

  it('gives the others\' renderers back after a minute closed', () => {
    for (const def of [menuOverlay, findOverlay, sidePanelOverlay, toastOverlayFor(() => {})]) expect(def.keep, def.name).toBe('warm')
  })
})
