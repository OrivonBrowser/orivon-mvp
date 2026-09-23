// Focus, for the e2e checks that need it. The shell's test launches show the
// window without activating it (ORIVON_WINDOW_NO_FOCUS), so a tab has no
// focus until a test gives it one -- and a test may only do that under the
// virtual display, where nothing else can hold focus. Anywhere else, taking
// focus would take it from whoever is at the machine.
import type { ElectronApplication } from 'playwright'

/** True inside scripts/run-headless.mjs's xvfb-run, with Wayland stripped. */
export function underVirtualDisplay (): boolean {
  return process.platform === 'linux' && process.env['WAYLAND_DISPLAY'] === undefined &&
    (process.env['XAUTHORITY'] ?? '').includes('xvfb-run')
}

/** Gives the webContents showing `url` focus. Call only under the virtual display. */
export async function focusWebContents (app: ElectronApplication, url: string): Promise<void> {
  await app.evaluate(({ webContents }, target) => {
    webContents.getAllWebContents().find((c) => c.getURL() === target)?.focus()
  }, url)
}

export async function webContentsFocused (app: ElectronApplication, url: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, target) =>
    webContents.getAllWebContents().find((c) => c.getURL() === target)?.isFocused() === true, url)
}
