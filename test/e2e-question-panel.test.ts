// The panel every question to the person is drawn in, in the running shell: it opens inside the window, across the
// toolbar line and above the chrome, a click that lands in its first half second and a key typed at the page answer
// nothing, Escape is a refusal, a question for a tab that is not in front waits for it, and no native box opens.
// The question here is "Email link", which the shell asks itself. Set ORIVON_UI_SHOTS_DIR to also write
// screenshots of the panel in both colour schemes.
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { runCommand, safely, shoot } from './support/auth-support.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from './support/question-support.js'
import { html, launchShell, startServer, visit } from './support/qa-helpers.js'
import type { FixtureServer } from './support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay, waitFor } from './support/smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 120_000
const servers: FixtureServer[] = []

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function serve (title: string): Promise<string> {
  const server = await startServer((_request, response) => { html(response, `<!doctype html><title>${title}</title><body style="font:16px sans-serif"><h1>${title}</h1></body>`) })
  servers.push(server)
  return server.origin
}

/** Replaces the mail program with a recorder, so nothing reaches the machine. */
async function stubOpenExternal (app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __opened: string[] }
    g.__opened = []
    shell.openExternal = (async (url: string) => { g.__opened.push(url) }) as typeof shell.openExternal
  })
}
const opened = async (app: ElectronApplication): Promise<string[]> => await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened)

interface Geometry { panel: { x: number, y: number, width: number, height: number } | null, chromeHeight: number, onTop: boolean }

/** Where the panel's view sits in the window, how tall the chrome is, and whether nothing is stacked above the panel. */
async function geometry (app: ElectronApplication): Promise<Geometry> {
  return await app.evaluate(({ BaseWindow }) => {
    const [win] = BaseWindow.getAllWindows()
    const children = (win?.contentView.children ?? []) as unknown as Array<{ getBounds: () => { x: number, y: number, width: number, height: number }, webContents?: { getURL: () => string } }>
    const urlOf = (child: (typeof children)[number]): string => child.webContents?.getURL() ?? ''
    const panel = children.find((child) => urlOf(child).includes('overlay=question'))
    const chrome = children.find((child) => urlOf(child).includes('index.html') && !urlOf(child).includes('overlay='))
    return {
      panel: panel?.getBounds() ?? null,
      chromeHeight: chrome?.getBounds().height ?? 0,
      onTop: panel !== undefined && children.indexOf(panel) === children.length - 1
    }
  })
}

it('opens in the window across the toolbar line, ignores a rushed click and a key at the page, and Escape refuses', async () => {
  const origin = await serve('Panel fixture')
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    await stubOpenExternal(app)
    const view = await visit(app, chrome, `${origin}/`)

    await runCommand(chrome, 'share.email')
    const panel = await waitQuestion(app)
    // A press in the first half second. The page's own look-ready class is cleared first, so what refuses it is main's guard,
    // which counts from the page drawing the question and so is still running however slowly the page loaded.
    await panel.evaluate(() => {
      document.querySelector('.q')?.classList.remove('arming')
      document.querySelector<HTMLButtonElement>('.q .btn.primary')?.click()
    })
    await delay(100)
    expect(await questionGone(app)).toBe(false)
    expect(await opened(app)).toEqual([])
    // The page's class is gone, so the page no longer says when main's guard has run out: wait it out before a real answer.
    await delay(500)
    const said = await readQuestion(panel)
    expect(said.message).toBe('Open your mail program with this page\'s link?')
    expect(said.buttons).toEqual(['Cancel', 'Allow'])
    expect(await panel.getAttribute('.q', 'role')).toBe('alertdialog')

    // Inside the window, its top edge in the toolbar (below the tab strip) and above the chrome view.
    const where = await geometry(app)
    expect(where.panel).not.toBeNull()
    expect(where.panel?.y).toBeGreaterThan(36)
    expect(where.panel?.y).toBeLessThan(where.chromeHeight)
    expect(where.onTop).toBe(true)

    // Focus is on the panel, never a button; a key typed at the page answers nothing.
    expect(await panel.evaluate(() => document.activeElement?.classList.contains('q'))).toBe(true)
    await view.keyboard.press('Enter')
    await view.keyboard.press('Space')
    await delay(300)
    expect(await questionGone(app)).toBe(false)
    expect(await opened(app)).toEqual([])

    await shoot(app, chrome, panel, 'question-panel')

    // Escape is a refusal.
    await safely(panel.keyboard.press('Escape'))
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await opened(app)).toEqual([])

    // The same question again, answered with the real button once the guard has passed.
    await runCommand(chrome, 'share.email')
    await answerQuestion(app, 'Allow')
    expect(await waitFor(async () => (await opened(app)).length === 1)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('keeps a question for a tab that is not in front until its tab comes back', async () => {
  const origin = await serve('Waiting fixture')
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    await stubOpenExternal(app)
    await visit(app, chrome, `${origin}/`)
    await runCommand(chrome, 'share.email')
    const panel = await waitQuestion(app)
    expect(await panel.locator('.q').count()).toBe(1)

    // A tab switch hides the panel; coming back shows it again, and it is still unanswered.
    await runCommand(chrome, 'tab.new')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await runCommand(chrome, 'tab.close')
    const again = await waitQuestion(app)
    expect((await readQuestion(again)).message).toBe('Open your mail program with this page\'s link?')
    expect(await opened(app)).toEqual([])

    await answerQuestion(app, 'Cancel')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await opened(app)).toEqual([])
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
