// Which browser a process is: another profile keeps its data apart, a launch
// that cannot be understood refuses to start, a second start of a running
// profile hands over to it (a bare one opens a new window, `--new-window` and
// `--new-private-window` ask for one), and a private session lives in a directory
// of its own that holds none of the person's data.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { clickAddressBarRetrying, pressKey } from '../support/e2e-helpers.js'
import { privatePeer } from '../support/private-peer.js'
import type { PrivatePeer } from '../support/private-peer.js'
import { ABSENCE_SETTLE_MS, bookmarkUrls, delay, evaluateRetrying, findChrome, HERMETIC_RESOLVER, tabIds, waitFor, waitForTab } from '../support/smoke-helpers.mjs'

let server: Server
let origin = ''
const scratch: string[] = []
const peerPids: number[] = []

beforeAll(async () => {
  server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(`<!doctype html><title>Page ${request.url ?? ''}</title><p>${request.url ?? ''}</p>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  for (const pid of peerPids) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 90_000
const PROFILE = '0123456789ab'
const electronBinary = createRequire(import.meta.url)('electron') as string

async function launched (args: string[] = [], seed?: (dir: string) => void): Promise<{ app: ElectronApplication, chrome: Page }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER, ...args], ...(seed === undefined ? {} : { seedProfile: (dir: string) => { seed(dir) } }) })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

function seedProfile (home: string): void {
  mkdirSync(join(home, 'profiles', PROFILE), { recursive: true })
  writeFileSync(join(home, 'profiles', PROFILE, 'profile.json'), JSON.stringify({ version: 1, name: 'Work', color: 'green', created: 1 }))
}

const windowCount = async (app: ElectronApplication): Promise<number> => await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows().length)
const userDataOf = async (app: ElectronApplication): Promise<string> => await app.evaluate(({ app: electron }) => electron.getPath('userData'))

/** Runs Orivon to completion, for a launch that is meant to end at once: what it printed, and how it ended. */
async function runToExit (args: string[], userData: string, timeoutMs = 20_000): Promise<{ code: number | null, output: string }> {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronBinary, ['.', `--user-data-dir=${userData}`, '--no-sandbox', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += String(chunk) })
  child.stderr.on('data', (chunk: Buffer) => { output += String(chunk) })
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL') }, timeoutMs)
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, output }) })
  })
}

it('keeps a profile\'s data in a directory of its own, apart from the default profile\'s', async () => {
  let home = ''
  const { app, chrome } = await launched([`--orivon-profile=${PROFILE}`], (dir) => { home = dir; seedProfile(dir) })
  try {
    const dir = await userDataOf(app)
    expect(dir).toBe(join(home, 'profiles', PROFILE))

    await clickAddressBarRetrying(chrome, `${origin}/mine`)
    expect((await waitForTab(chrome, { address: `${origin}/mine` })).ok).toBe(true)
    await pressKey(app, `${origin}/mine`, 'D', ['control'])
    expect(await waitFor(async () => (await bookmarkUrls(chrome)).length === 1)).toBe(true)

    expect(await waitFor(() => existsSync(join(dir, 'bookmarks.json')))).toBe(true)
    expect(existsSync(join(home, 'bookmarks.json'))).toBe(false)
    // It is running, and says so where a deletion would look.
    expect(existsSync(join(dir, '.orivon-running'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('refuses to start for a launch it cannot understand, and creates nothing', async () => {
  const home = join(tmpdir(), `orivon-launch-refusal-${String(process.pid)}`)
  scratch.push(home)
  mkdirSync(home, { recursive: true })
  seedProfile(home)

  const cases: Array<[string[], RegExp]> = [
    [['--orivon-profile=../evil'], /is not the id of a profile/],
    [['--orivon-profile=deadbeef0000'], /there is no profile/],
    [['--orivon-private', `--orivon-profile=${PROFILE}`], /cannot also be a profile/],
    [['--orivon-private', '--orivon-private-dir=/etc'], /not the directory of a private session/],
    [['--orivon-private', `--orivon-private-dir=${join(tmpdir(), 'orivon-private-nonexi')}`], /not the directory of a private session/]
  ]
  for (const [args, message] of cases) {
    const { code, output } = await runToExit(args, home)
    expect(code, args.join(' ')).toBe(2)
    expect(output, args.join(' ')).toMatch(message)
  }
  expect(readdirSync(join(home, 'profiles'))).toEqual([PROFILE])
  expect(existsSync(join(home, 'bookmarks.json'))).toBe(false)
}, TEST_TIMEOUT_MS)

it('hands a second start of a running profile over to it, with the address it was given', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await userDataOf(app)
    // The window's first tab is drawn on the first state push; count from there.
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    const before = 1

    const { code } = await runToExit([`${origin}/from-elsewhere`], dir)

    expect(code).toBe(0)
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect((await waitForTab(chrome, { address: `${origin}/from-elsewhere` })).ok).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens a new window for a second start that names nothing, and leaves the window in use alone', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await userDataOf(app)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)
    expect(await windowCount(app)).toBe(1)

    expect((await runToExit([], dir)).code).toBe(0)

    expect(await waitFor(async () => (await windowCount(app)) === 2)).toBe(true)
    expect((await tabIds(chrome)).length).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens the address of --new-window in a window of its own', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await userDataOf(app)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)

    expect((await runToExit(['--new-window', `${origin}/in-a-window`], dir)).code).toBe(0)

    expect(await waitFor(async () => (await windowCount(app)) === 2)).toBe(true)
    expect(await waitFor(() => app.windows().some((page) => page.url() === `${origin}/in-a-window`))).toBe(true)
    expect((await tabIds(chrome)).length).toBe(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens nothing for a file or a mail address handed to a running browser', async () => {
  const { app, chrome } = await launched()
  try {
    const dir = await userDataOf(app)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)

    for (const operand of ['./a.html', 'mailto:someone@example.com']) expect((await runToExit([operand], dir)).code).toBe(0)
    await delay(ABSENCE_SETTLE_MS)

    expect(await windowCount(app)).toBe(1)
    expect((await tabIds(chrome)).length).toBe(1)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it.skipIf(process.platform !== 'linux')('hands --new-private-window to the running browser, which starts a private session whose directory goes when it ends', async () => {
  const { app, chrome } = await launched()
  let dir = ''
  try {
    const userData = await userDataOf(app)
    expect(await waitFor(async () => (await tabIds(chrome)).length === 1)).toBe(true)

    expect((await runToExit(['--new-private-window'], userData)).code).toBe(0)

    let peer: PrivatePeer | undefined
    expect(await waitFor(() => { peer = privatePeer(userData); return peer !== undefined })).toBe(true)
    const found = peer as PrivatePeer
    peerPids.push(...found.pids)
    dir = found.dir
    scratch.push(dir)
    expect(dir.startsWith(join(tmpdir(), 'orivon-private-'))).toBe(true)
    expect(await waitFor(() => existsSync(join(dir, '.orivon-private.json')), 30_000)).toBe(true)
    // The running browser opened no window of its own for it.
    expect(await windowCount(app)).toBe(1)

    for (const pid of found.pids) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
    expect(await waitFor(() => !existsSync(dir), 15_000)).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('runs as a private session when --new-private-window starts a browser that is not yet running, and leaves the profile unlocked', async () => {
  let home = ''
  const { app } = await launched(['--new-private-window'], (dir) => { home = dir })
  let dir = ''
  try {
    dir = await userDataOf(app)
    scratch.push(dir)
    expect(dir.startsWith(join(tmpdir(), 'orivon-private-'))).toBe(true)
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://private')))).toBe(true)
    // The profile was not claimed: a start of it is not handed over to this process.
    expect(existsSync(join(home, '.orivon-running'))).toBe(false)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)

it('runs a private session in a directory of its own, with the settings it began with and nothing of the person\'s', async () => {
  let home = ''
  const { app, chrome } = await launched(['--orivon-private'], (dir) => {
    home = dir
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'appearance.theme': 'dark' } }))
    writeFileSync(join(dir, 'bookmarks.json'), JSON.stringify([{ url: 'https://mine.example/', title: 'mine', favicon: null }]))
    writeFileSync(join(dir, 'history.db'), 'the person\'s history')
    mkdirSync(join(dir, 'identity'), { recursive: true })
    writeFileSync(join(dir, 'identity', 'seed.json'), '{"version":1,"ciphertext":"c2VjcmV0"}')
  })
  let dir = ''
  try {
    dir = await userDataOf(app)
    scratch.push(dir)
    expect(dir.startsWith(join(tmpdir(), 'orivon-private-'))).toBe(true)
    expect(dir).not.toBe(home)

    // The settings came along; nothing else did.
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark')
    expect(await waitFor(async () => (await bookmarkUrls(chrome)).length === 0, 3000)).toBe(true)
    expect(existsSync(join(dir, 'bookmarks.json'))).toBe(false)
    expect(existsSync(join(dir, 'history.db'))).toBe(false)
    expect(existsSync(join(dir, 'identity', 'seed.json'))).toBe(false)
    expect(existsSync(join(dir, '.orivon-private.json'))).toBe(true)

    // It opens on the page that says what it does, and no welcome screen, and its chrome says it is private.
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://private')))).toBe(true)
    expect(await waitFor(async () => await evaluateRetrying(chrome, () => document.documentElement.dataset['private']) === 'true')).toBe(true)
    expect(await evaluateRetrying(chrome, () => { const el = document.querySelector<HTMLElement>('#profile-chip'); return el === null || el.hidden ? null : el.textContent })).toBe('Private')

    // Pages visited leave no history, in this session or on the person's disk.
    await chrome.click('#new-tab')
    await clickAddressBarRetrying(chrome, `${origin}/secret`)
    expect((await waitForTab(chrome, { address: `${origin}/secret` })).ok).toBe(true)
    await delay(800)
    expect(existsSync(join(dir, 'history.db'))).toBe(false)
    expect(existsSync(join(home, 'history.db'))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)
