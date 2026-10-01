// Where an extension's popup opens when a shortcut, not a click, asks for it:
// under the extension's own toolbar icon, else under the Extensions button,
// else at the toolbar's right end. The first two are read off the chrome page,
// which alone knows where it drew them.
import type { Rectangle } from 'electron'
import { CHROME_TOP_ROWS } from '../shell/window-layout.js'
import type { ShellWindow } from '../shell/window-registry.js'

const EXTENSION_ID = /^[a-p]{32}$/
const EXTENSIONS_BUTTON = 'extensions-menu-btn'
const TAB_STRIP_HEIGHT = 36

/** The script the chrome page runs. `id` is checked before it is written into the source. */
export function anchorScript (extensionId: string): string | null {
  if (!EXTENSION_ID.test(extensionId)) return null
  return `(() => {
  const box = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null
  }
  const list = document.querySelector('browser-action-list')
  const icon = list && list.shadowRoot ? list.shadowRoot.querySelector('[id="${extensionId}"]') : null
  return box(icon) || box(document.getElementById('${EXTENSIONS_BUTTON}'))
})()`
}

export function parseAnchor (value: unknown): Rectangle | null {
  if (typeof value !== 'object' || value === null) return null
  const { x, y, width, height } = value as Record<string, unknown>
  if (![x, y, width, height].every((part) => typeof part === 'number' && Number.isFinite(part))) return null
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

/** The toolbar's right end, for a window whose chrome page did not answer. */
export function fallbackAnchor (contentWidth: number): Rectangle {
  return { x: Math.max(0, contentWidth - 100), y: TAB_STRIP_HEIGHT, width: 32, height: CHROME_TOP_ROWS - TAB_STRIP_HEIGHT }
}

export async function anchorFor (window: ShellWindow, extensionId: string): Promise<Rectangle> {
  const script = anchorScript(extensionId)
  if (script !== null && !window.chrome.webContents.isDestroyed()) {
    try {
      const found = parseAnchor(await window.chrome.webContents.executeJavaScript(script))
      if (found !== null) return found
    } catch {
      // The chrome page is reloading: the fallback is as good as a measurement.
    }
  }
  return fallbackAnchor(window.window.getContentBounds().width)
}
