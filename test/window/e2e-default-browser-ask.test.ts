// The ask to become the default browser, half a minute into first use and then weekly, in the running shell. The
// operating system is replaced by the test seam's recording host (ORIVON_TEST_DEFAULT_BROWSER), so nothing here
// changes the machine's default; the ask's own clock is a file in the profile that each case writes in advance, so no
// case waits a week, or the half minute.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { focusWebContents, underVirtualDisplay } from '../support/focus-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { ABSENCE_SETTLE_MS, delay, findChrome, HERMETIC_RESOLVER, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

const TEST_TIMEOUT_MS = 90_000
const DAY_MS = 86_400_000
const FILE = 'default-browser-ask.json'

let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end('<!doctype html><title>Ask fixture</title><body style="font:16px sans-serif"><h1>Ask fixture</h1></body>')
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface AskFile { firstSeenAt: number, lastAskedAt: number | null, stopped: boolean }
interface Launched { app: ElectronApplication, chrome: Page, file: () => AskFile | undefined, startedAt: number }

/** Starts with the ask's clock set `days` ago (first seen, last asked), or first seen `firstSeenMsAgo` and never asked, or with no file at all. The page in front has the focus: an ask waits for a window in use. */
async function launched (options: { days?: [number, number], firstSeenMsAgo?: number, mode?: string, args?: string[] }): Promise<Launched> {
  const startedAt = Date.now()
  let userData = ''
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    env: { ORIVON_TEST_DEFAULT_BROWSER: options.mode ?? 'can-set' },
    seedProfile: (dir: string) => {
      userData = dir
      if (options.firstSeenMsAgo !== undefined) {
        const state: AskFile = { firstSeenAt: startedAt - options.firstSeenMsAgo, lastAskedAt: null, stopped: false }
        writeFileSync(join(dir, FILE), JSON.stringify(state))
      }
      if (options.days === undefined) return
      const [first, last] = options.days
      const state: AskFile = { firstSeenAt: startedAt - first * DAY_MS, lastAskedAt: startedAt - last * DAY_MS, stopped: false }
      writeFileSync(join(dir, FILE), JSON.stringify(state))
    }
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await stubNativeDialogs(app)
  await clickAddressBarRetrying(chrome, `${origin}/`)
  expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)
  await focusWebContents(app, `${origin}/`)
  const file = (): AskFile | undefined => existsSync(join(userData, FILE)) ? JSON.parse(readFileSync(join(userData, FILE), 'utf8')) as AskFile : undefined
  return { app, chrome, file, startedAt }
}

/** Runs the check now. The call returns once the question is answered, so it is not awaited. */
async function askNow (app: ElectronApplication): Promise<void> {
  await app.evaluate(() => { void (globalThis as unknown as { __orivonDevDefaultBrowserAskNow?: () => Promise<void> }).__orivonDevDefaultBrowserAskNow?.() })
}

const recording = async (app: ElectronApplication): Promise<{ setDefault: string[], isDefault: string[] }> =>
  await app.evaluate(() => (globalThis as unknown as { __orivonDevDefaultBrowser: { setDefault: string[], isDefault: string[] } }).__orivonDevDefaultBrowser)

const run = it.skipIf(!underVirtualDisplay())

run('asks with three buttons in the third week, and Not now writes the time of the ask and registers nothing', async () => {
  const { app, file, startedAt } = await launched({ days: [15, 8] })
  try {
    await askNow(app)
    const question = await waitQuestion(app)
    const said = await readQuestion(question)
    expect(said.title).toBe('Make Orivon your default browser?')
    // The way out is drawn first, on the left, as in every question.
    expect(said.buttons).toEqual(['Not now', 'Make default', 'Don\'t ask again'])
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => (file()?.lastAskedAt ?? 0) >= startedAt)).toBe(true)
    expect(file()?.stopped).toBe(false)
    expect(file()?.firstSeenAt).toBeLessThan(startedAt - 14 * DAY_MS)
    expect((await recording(app)).setDefault).toEqual([])
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('stops asking for good when the person says so', async () => {
  const { app, file } = await launched({ days: [15, 8] })
  try {
    await askNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Don\'t ask again')
    expect(await waitFor(() => file()?.stopped === true)).toBe(true)
    await askNow(app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('registers http and https when the person says Make default', async () => {
  const { app } = await launched({ days: [15, 8] })
  try {
    await askNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Make default')
    expect(await waitFor(async () => (await recording(app)).setDefault.length === 2, 10_000)).toBe(true)
    expect((await recording(app)).setDefault).toEqual(['http', 'https'])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks with two buttons in the second week, before "Don\'t ask again" is offered', async () => {
  const { app } = await launched({ days: [8, 8] })
  try {
    await askNow(app)
    const said = await readQuestion(await waitQuestion(app))
    expect(said.buttons).toEqual(['Not now', 'Make default'])
    await answerQuestion(app, 'Not now')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks nothing on a fresh profile, and starts its clock once a window is in use', async () => {
  const { app, file, startedAt } = await launched({})
  try {
    await askNow(app)
    expect(await waitFor(() => file() !== undefined)).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(file()?.stopped).toBe(false)
    expect(file()?.firstSeenAt).toBeGreaterThanOrEqual(startedAt)
    expect(file()?.lastAskedAt).toBeNull()
    expect((await recording(app)).isDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks the first time half a minute after the profile was first seen in use, with two buttons', async () => {
  const { app, file, startedAt } = await launched({ firstSeenMsAgo: 31_000 })
  try {
    await askNow(app)
    const said = await readQuestion(await waitQuestion(app))
    expect(said.title).toBe('Make Orivon your default browser?')
    expect(said.buttons).toEqual(['Not now', 'Make default'])
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => (file()?.lastAskedAt ?? 0) >= startedAt)).toBe(true)
    expect((await recording(app)).setDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks by itself on a fresh profile, half a minute after the window is first in use and not before', async () => {
  const { app, file } = await launched({})
  try {
    // No askNow: the browser's own clock. Its first look (10 s after start) finds the window in use and starts the count.
    expect(await waitFor(() => file() !== undefined, 20_000)).toBe(true)
    const seenAt = file()?.firstSeenAt ?? 0
    expect(file()?.lastAskedAt).toBeNull()
    await delay(Math.max(0, seenAt + 25_000 - Date.now()))
    expect(await questionGone(app)).toBe(true)
    const said = await readQuestion(await waitQuestion(app, 20_000))
    expect(Date.now() - seenAt).toBeGreaterThanOrEqual(30_000)
    expect(said.buttons).toEqual(['Not now', 'Make default'])
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => (file()?.lastAskedAt ?? 0) >= seenAt + 30_000)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks nothing of a window that is not in use', async () => {
  const { app, chrome } = await launched({ days: [15, 8] })
  try {
    // The question waits for a window the person can see: a hidden one is not one.
    await app.evaluate(({ BaseWindow }) => { for (const window of BaseWindow.getAllWindows()) window.hide() })
    await chrome.evaluate(() => {})
    await askNow(app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks nothing when Orivon already is the default, and counts it as asked', async () => {
  const { app, file, startedAt } = await launched({ days: [15, 8], mode: 'default' })
  try {
    await askNow(app)
    expect(await waitFor(() => (file()?.lastAskedAt ?? 0) >= startedAt)).toBe(true)
    expect(await questionGone(app)).toBe(true)
    expect((await recording(app)).setDefault).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('never asks from a private session', async () => {
  const { app, file, startedAt } = await launched({ days: [15, 8], args: ['--orivon-private'] })
  try {
    expect(await app.evaluate(() => typeof (globalThis as unknown as { __orivonDevDefaultBrowserAskNow?: unknown }).__orivonDevDefaultBrowserAskNow)).toBe('undefined')
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    // The private session keeps its own directory; the profile's file is as the case left it.
    expect(file()?.lastAskedAt).toBeLessThan(startedAt)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
