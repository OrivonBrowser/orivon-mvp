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

/** Starts logging every webContents that takes the keyboard, by the address it has when it does: a view that is still blank is named 'blank'. */
export async function startFocusLog (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents }) => {
    const log: string[] = []
    ;(globalThis as unknown as { __focusLog: string[] }).__focusLog = log
    const watch = (wc: Electron.WebContents): void => { wc.on('focus', () => { log.push(wc.getURL() === '' ? 'blank' : wc.getURL()) }) }
    for (const wc of webContents.getAllWebContents()) watch(wc)
    electronApp.on('web-contents-created', (_event, wc) => { watch(wc) })
  })
}

export async function readFocusLog (app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => [...(globalThis as unknown as { __focusLog: string[] }).__focusLog])
}

export async function clearFocusLog (app: ElectronApplication): Promise<void> {
  await app.evaluate(() => { (globalThis as unknown as { __focusLog: string[] }).__focusLog.length = 0 })
}
