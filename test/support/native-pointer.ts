// A real pointer button on the virtual display, for the checks a debugger's input cannot make: the window's own
// hit test (drag regions, the frame) runs before a page sees any press, and only a press that comes from the
// display passes through it. Call only where underVirtualDisplay() holds (focus-helpers.ts).
import { execFileSync } from 'node:child_process'

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
