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

/** A real left press on the centre of the first element `selector` names in `page`, a tab's or an overlay's: the window's content area, plus the view's place in it, plus the element's place in the view. */
export async function pointerPressOn (app: ElectronApplication, page: Page, selector: string): Promise<void> {
  const box = await page.locator(selector).first().boundingBox()
  if (box === null) throw new Error(`${selector} has no box`)
  const origin = await app.evaluate(({ BaseWindow }, url) => {
    for (const win of BaseWindow.getAllWindows()) {
      const content = win.getContentBounds()
      const view = win.contentView.children.find((child) => (child as unknown as { webContents?: { getURL: () => string } }).webContents?.getURL() === url)
      const at = view?.getBounds()
      if (at !== undefined) return { x: content.x + at.x, y: content.y + at.y }
    }
    return null
  }, page.url())
  if (origin === null) throw new Error(`no view shows ${page.url()}`)
  pressPointer(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2, 1)
}
