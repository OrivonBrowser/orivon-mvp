// How a file on this computer gets into a tab: the Open file command, a path or a file: address on the command line of a
// second start (absolute, or relative to where that start was made), a restored session, and the star on its page. A path that
// is not there opens nothing. Real windows, the real strip and a real second process; the native dialog is stubbed.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { pressKey } from '../support/e2e-helpers.js'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { nativeDialogsAsked, stubNativeDialogs } from '../support/question-support.js'
import { ABSENCE_SETTLE_MS, delay, waitFor } from '../support/smoke-helpers.mjs'

const electronBinary = createRequire(import.meta.url)('electron') as string

let dir: string
const pathOf = (name: string): string => join(dir, name)
const urlOf = (name: string): string => pathToFileURL(pathOf(name)).href

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-open-local-')))
  for (const name of ['a.html', 'b.html', 'c.html', 'd.html']) writeFileSync(pathOf(name), `<!doctype html><title>${name}</title><p>${name}</p>`)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Every local file a tab shows, by address. */
const fileTabs = async (app: ElectronApplication): Promise<string[]> =>
  (await app.evaluate(({ webContents }) => webContents.getAllWebContents().filter((wc) => !wc.isDestroyed()).map((wc) => wc.getURL()).filter((url) => url.startsWith('file:')))).sort()

const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))
const runCommand = async (chrome: Page, id: string): Promise<void> => {
  await chrome.evaluate((commandId) => { (window as unknown as { orivonShell: { runCommand: (i: string) => void } }).orivonShell.runCommand(commandId) }, id)
}

/** A second start of the browser, run from `cwd`, that hands its operands to the running one and ends. */
async function secondStart (operands: string[], userData: string, cwd: string): Promise<number | null> {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronBinary, [process.cwd(), `--user-data-dir=${userData}`, '--no-sandbox', ...operands], { env, cwd, stdio: 'ignore' })
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, 30_000)
    child.once('exit', (code) => { clearTimeout(timer); resolve(code) })
  })
}

it('opens the file the Open file command picks, in a tab of its own, and nothing when the dialog is cancelled', async () => {
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app, { open: [pathOf('a.html')] })
    await runCommand(chrome, 'file.open')
    expect(await waitFor(async () => (await fileTabs(app)).includes(urlOf('a.html')))).toBe(true)
    expect(await nativeDialogsAsked(app)).toContain('showOpenDialog')

    await stubNativeDialogs(app)
    await runCommand(chrome, 'file.open')
    await delay(ABSENCE_SETTLE_MS)
    expect(await fileTabs(app)).toEqual([urlOf('a.html')])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens the files a second start names, a path or a file: address, absolute or relative to where it was made, and nothing for a path that is not there', async () => {
  const { app } = await launchShell()
  try {
    const userData = await userDataOf(app)
    expect(await secondStart([pathOf('a.html'), urlOf('b.html')], userData, tmpdir())).toBe(0)
    expect(await waitFor(async () => (await fileTabs(app)).length === 2)).toBe(true)
    expect(await fileTabs(app)).toEqual([urlOf('a.html'), urlOf('b.html')])

    expect(await secondStart(['c.html'], userData, dir)).toBe(0)
    expect(await waitFor(async () => (await fileTabs(app)).includes(urlOf('c.html')))).toBe(true)

    expect(await secondStart(['missing.html', '/definitely/not/here.html'], userData, dir)).toBe(0)
    await delay(ABSENCE_SETTLE_MS)
    expect(await fileTabs(app)).toEqual([urlOf('a.html'), urlOf('b.html'), urlOf('c.html')])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('brings a local file back from the last session, and keeps one a person starred', async () => {
  const session = JSON.stringify({ version: 1, clean: true, windows: [{ active: 0, tabs: [{ url: urlOf('d.html'), title: 'd.html', pinned: false }] }] })
  const { app, chrome } = await launchShell({
    seedProfile: async (userData: string) => {
      mkdirSync(userData, { recursive: true })
      writeFileSync(join(userData, 'settings.json'), JSON.stringify({ version: 1, values: { 'startup.mode': 'continue' } }))
      writeFileSync(join(userData, 'session.json'), session)
    }
  })
  try {
    expect(await waitFor(async () => (await fileTabs(app)).includes(urlOf('d.html')))).toBe(true)
    // The star on a local file's page keeps its file: address.
    await pressKey(app, urlOf('d.html'), 'D', ['control'])
    const bookmarks = join(await userDataOf(app), 'bookmarks.json')
    expect(await waitFor(() => existsSync(bookmarks) && readFileSync(bookmarks, 'utf8').includes(urlOf('d.html')))).toBe(true)
    expect(chrome.isClosed()).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
