// Focus, for the e2e checks that need it. The shell's test launches show the
// window without activating it (ORIVON_WINDOW_NO_FOCUS), so a tab has no
// focus until a test gives it one -- and a test may only do that under the
// virtual display, where nothing else can hold focus. Anywhere else, taking
// focus would take it from whoever is at the machine.
import type { ElectronApplication, Page } from 'playwright'

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

/** Lets `page` feel the keyboard leave and return as a person's window does. Playwright pins every page it attaches to as focused, so the blur and focus a press on another view causes never reach the page; the second call turns that off for the page whichever session set it. Then gives the page's webContents the keyboard. Call only under the virtual display. */
export async function useRealFocus (app: ElectronApplication, page: Page): Promise<void> {
  const client = await page.context().newCDPSession(page)
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  await client.send('Emulation.setFocusEmulationEnabled', { enabled: false })
  await focusWebContents(app, page.url())
}

/** A press on `selector` of an overlay's page as a person makes it: the view takes the keyboard from the page first, as a press in a real window does, and then the click lands. Playwright's own click is injected into the renderer and leaves the keyboard where it was. Call only under the virtual display. */
export async function pressOn (app: ElectronApplication, overlay: Page, selector: string, options: { position?: { x: number, y: number } } = {}): Promise<void> {
  await focusWebContents(app, overlay.url())
  await overlay.click(selector, options)
}
