// A real pointer button on the virtual display, for the checks a debugger's input cannot make: the window's own
// hit test (drag regions, the frame) runs before a page sees any press, and only a press that comes from the
// display passes through it. Call only where underVirtualDisplay() holds (focus-helpers.ts).
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from 'playwright'

/** A press and release of `button` (1 left, 2 middle, 3 right) at a point in screen pixels. */
export function pressPointer (x: number, y: number, button: number): void {
  const script = [
    'import ctypes, sys, time',
    "x11 = ctypes.CDLL('libX11.so.6'); xtst = ctypes.CDLL('libXtst.so.6')",
    'x11.XOpenDisplay.restype = ctypes.c_void_p',
    'display = ctypes.c_void_p(x11.XOpenDisplay(None))',
    'x, y, button = [int(v) for v in sys.argv[1:4]]',
    'xtst.XTestFakeMotionEvent(display, -1, x, y, 0); x11.XFlush(display); time.sleep(0.15)',
    'xtst.XTestFakeButtonEvent(display, button, 1, 0); x11.XFlush(display); time.sleep(0.08)',
    'xtst.XTestFakeButtonEvent(display, button, 0, 0); x11.XFlush(display); time.sleep(0.1)',
    'x11.XCloseDisplay(display)'
  ].join('\n')
  execFileSync('python3', ['-c', script, String(Math.round(x)), String(Math.round(y)), String(button)], { timeout: 15_000 })
}

/**
 * A real left press on the centre of the first element `selector` names in `page`, a tab's or an overlay's: the window's
 * content area, plus the view's place in it, plus the element's place in the view, scaled by the view's zoom and the
 * display's scale factor into the screen pixels the pointer moves in. Throws when no view, or more than one that is
 * showing, has the page's address: a press then could land on the wrong one.
 */
export async function pointerPressOn (app: ElectronApplication, page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) throw new Error(`${selector} has no box`)
  const at = await app.evaluate(({ BaseWindow, screen }, wanted) => {
    const found: Array<{ visible: boolean, x: number, y: number }> = []
    for (const win of BaseWindow.getAllWindows()) {
      const content = win.getContentBounds()
      for (const child of win.contentView.children) {
        const contents = (child as unknown as { webContents?: { getURL: () => string, getZoomFactor: () => number } }).webContents
        if (contents?.getURL() !== wanted.url) continue
        const place = child.getBounds()
        const zoom = contents.getZoomFactor()
        const dip = { x: content.x + place.x + wanted.x * zoom, y: content.y + place.y + wanted.y * zoom }
        const pixels = typeof screen.dipToScreenPoint === 'function' ? screen.dipToScreenPoint(dip) : dip
        found.push({ visible: child.getVisible(), ...pixels })
      }
    }
    return found
  }, { url: page.url(), x: box.x + box.width / 2, y: box.y + box.height / 2 })
  const showing = at.length > 1 ? at.filter((view) => view.visible) : at
  const target = showing[0]
  if (target === undefined || showing.length !== 1) throw new Error(`${String(showing.length)} views show ${page.url()}; a press needs exactly one`)
  pressPointer(target.x, target.y, 1)
}
