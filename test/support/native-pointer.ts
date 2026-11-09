// A real pointer button on the system's own input queue, for the checks a debugger's input cannot make: the window's
// own hit test (drag regions, the frame) runs before a page sees any press, and only a press that comes from the
// system passes through it. Call it only where realPointerAvailable() holds: the press moves the pointer, so it
// belongs on the headless runner's virtual display or on a CI runner nobody sits at, never on a person's screen.
import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from 'playwright'
import { underVirtualDisplay } from './focus-helpers.js'

/**
 * Whether a real press may be made here: Linux under the virtual display (X11 XTest), or Windows or macOS on a
 * GitHub-hosted runner (`RUNNER_ENVIRONMENT=github-hosted`), whose desktop belongs to the job. A self-hosted runner
 * sets `GITHUB_ACTIONS` too and can be a person's desktop, and so can any other Windows or macOS machine: there it is
 * false, because the press would take their pointer.
 */
export function realPointerAvailable (platform: string = process.platform, env: Record<string, string | undefined> = process.env): boolean {
  if (platform === 'linux') return underVirtualDisplay()
  return (platform === 'win32' || platform === 'darwin') && env['GITHUB_ACTIONS'] === 'true' && env['RUNNER_ENVIRONMENT'] === 'github-hosted'
}

/** The program and arguments that move the pointer to (x, y), press `button` (1 left, 2 middle, 3 right) there and release it. */
export function pointerCommand (platform: string, x: number, y: number, button: number): { file: string, args: string[] } {
  const at = [Math.round(x), Math.round(y)]
  if (platform === 'win32') {
    // Windows mouse_event flags: left, right and middle button down and up.
    const [down = 0x2, up = 0x4] = ({ 1: [0x2, 0x4], 2: [0x20, 0x40], 3: [0x8, 0x10] } as Record<number, number[]>)[button] ?? []
    const script = [
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class OrivonPointer { [DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware(); [DllImport(\"user32.dll\")] public static extern bool SetCursorPos(int x, int y); [DllImport(\"user32.dll\")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra); }'",
      // Without this the system scales the point as it does for a program that cannot draw at the display's density.
      '[void][OrivonPointer]::SetProcessDPIAware()',
      `[void][OrivonPointer]::SetCursorPos(${String(at[0])}, ${String(at[1])})`,
      'Start-Sleep -Milliseconds 150',
      `[OrivonPointer]::mouse_event(${String(down)}, 0, 0, 0, [UIntPtr]::Zero)`,
      'Start-Sleep -Milliseconds 80',
      `[OrivonPointer]::mouse_event(${String(up)}, 0, 0, 0, [UIntPtr]::Zero)`,
      'Start-Sleep -Milliseconds 100'
    ].join('\n')
    // Encoded, so no quote in the script meets the command line's own parsing.
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] }
  }
  if (platform === 'darwin') {
    // CoreGraphics button numbers: 0 left, 1 right, 2 other; the event types for each.
    const [down = 1, up = 2, code = 0] = ({ 1: [1, 2, 0], 2: [25, 26, 2], 3: [3, 4, 1] } as Record<number, number[]>)[button] ?? []
    const lines = [
      "ObjC.import('CoreGraphics'); ObjC.import('Foundation')",
      `const post = (type) => { const event = $.CGEventCreateMouseEvent(null, type, { x: ${String(at[0])}, y: ${String(at[1])} }, ${String(code)}); $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, 1); $.CGEventPost($.kCGHIDEventTap, event) }`,
      'post($.kCGEventMouseMoved); $.NSThread.sleepForTimeInterval(0.15)',
      `post(${String(down)}); $.NSThread.sleepForTimeInterval(0.08)`,
      `post(${String(up)}); $.NSThread.sleepForTimeInterval(0.1)`
    ]
    return { file: 'osascript', args: ['-l', 'JavaScript', ...lines.flatMap((line) => ['-e', line])] }
  }
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
  return { file: 'python3', args: ['-c', script, String(at[0]), String(at[1]), String(button)] }
}

/** A press and release of `button` (1 left, 2 middle, 3 right) at a point in screen pixels. Throws where realPointerAvailable() does not hold, so no caller can take a person's pointer. */
export function pressPointer (x: number, y: number, button: number, platform: string = process.platform, env: Record<string, string | undefined> = process.env): void {
  if (!realPointerAvailable(platform, env)) throw new Error('pressPointer: a real press moves the pointer, so it runs only on the headless runner\'s virtual display or on a GitHub-hosted Windows or macOS runner (realPointerAvailable() is false here)')
  const { file, args } = pointerCommand(platform, x, y, button)
  execFileSync(file, args, { timeout: 30_000 })
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
