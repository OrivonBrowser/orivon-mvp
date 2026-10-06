// The browser's own update, in the running shell: a fixture server stands in for GitHub (a stable release, a newer
// nightly and a newer prerelease), signs its package list with a key the spec generates and hands the build as a
// trusted key. The installer is replaced by the test seam's recorder, so nothing here installs or restarts anything.
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
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
const APPIMAGE = 'Orivon-1.2.0-x86_64.AppImage'
const PACKAGE = Buffer.from('a small stand-in for the AppImage of release 1.2.0')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const PUBLIC_PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString()
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

type Tamper = 'none' | 'signature' | 'package'

const signedAssets = [{ name: 'orivon-update.json' }, { name: 'orivon-update.json.sig' }]
const release = (tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ tag_name: tag, name: tag, draft: false, prerelease: false, assets: signedAssets, ...extra })
const RELEASES = [
  release('v1.4.0', { prerelease: true }),
  release('v1.3.0-nightly.7', { name: 'Nightly 7' }),
  release('v1.2.0'),
  release('v1.1.0')
]

let server: Server
let origin = ''
let tamper: Tamper = 'none'
let requests: string[] = []

function manifestFor (version: string): { text: string, signature: string } {
  const text = `${JSON.stringify({ format: 'orivon-update/1', version, files: [{ name: APPIMAGE, size: PACKAGE.length, sha256: sha256(PACKAGE) }] }, null, 2)}\n`
  return { text, signature: sign(null, Buffer.from(text), privateKey).toString('base64') }
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '/'
    requests.push(path)
    if (path.startsWith('/releases')) {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify(RELEASES))
    } else if (path === '/download/v1.2.0/orivon-update.json') {
      response.end(manifestFor('1.2.0').text)
    } else if (path === '/download/v1.2.0/orivon-update.json.sig') {
      // The signature of another list: the manifest no longer matches what was signed.
      response.end(tamper === 'signature' ? manifestFor('9.9.9').signature : manifestFor('1.2.0').signature)
    } else if (path === `/download/v1.2.0/${APPIMAGE}`) {
      response.end(tamper === 'package' ? Buffer.alloc(PACKAGE.length, 'x') : PACKAGE)
    } else if (path.startsWith('/download/')) {
      response.statusCode = 404
      response.end()
    } else {
      response.setHeader('content-type', 'text/html')
      response.end('<!doctype html><title>Update fixture</title><body style="font:16px sans-serif"><h1>Update fixture</h1></body>')
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Launched { app: ElectronApplication, chrome: Page, userData: string }

/** Starts against the fixture, with the person's window in use. `record` swaps the installers for the recorder (and makes this copy installable, which a run from source never is). */
async function launched (options: { tamper?: Tamper, record?: boolean, args?: string[] } = {}): Promise<Launched> {
  tamper = options.tamper ?? 'none'
  requests = []
  let userData = ''
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...(options.args ?? [])],
    env: {
      ORIVON_TEST_UPDATE_SOURCE: origin,
      ORIVON_TEST_UPDATE_KEY: PUBLIC_PEM,
      ...(options.record === false ? {} : { ORIVON_TEST_UPDATE_INSTALL: 'record' })
    },
    seedProfile: (dir: string) => { userData = dir }
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  const chrome = findChrome(app)
  await stubNativeDialogs(app)
  await clickAddressBarRetrying(chrome, `${origin}/`)
  expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)
  await focusWebContents(app, `${origin}/`)
  return { app, chrome, userData }
}

/** Runs the daily look now; it returns once the question is answered, so it is not awaited. */
async function lookNow (app: ElectronApplication): Promise<void> {
  await app.evaluate(() => { void (globalThis as unknown as { __orivonDevUpdateCheckNow?: () => Promise<void> }).__orivonDevUpdateCheckNow?.() })
}

interface Recorded { kind: string, file: string, sha256: string }
const installs = async (app: ElectronApplication): Promise<Recorded[]> =>
  await app.evaluate(() => (globalThis as unknown as { __orivonDevUpdateInstalls?: Recorded[] }).__orivonDevUpdateInstalls ?? [])

const state = (userData: string): { lastCheckedAt?: number, lastNotifiedVersion?: string } | undefined => {
  const path = join(userData, 'update-check-state.json')
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as { lastCheckedAt?: number, lastNotifiedVersion?: string } : undefined
}

async function openAbout (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/about') })
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
  await page.waitForSelector('.layout')
  return page
}

const run = it.skipIf(!underVirtualDisplay())

run('asks about the newest stable release, never a nightly or a prerelease, and Install update hands the installer the signed package', async () => {
  const { app, userData } = await launched()
  try {
    await lookNow(app)
    const said = await readQuestion(await waitQuestion(app))
    expect(said.title).toBe('Orivon 1.2.0 is available')
    expect(said.message).toBe('You have 0.0.0.')
    expect([...said.buttons].sort()).toEqual(['Download from GitHub', 'Install update', 'Not now'])
    await answerQuestion(app, 'Install update')
    expect(await waitFor(async () => (await installs(app)).length === 1)).toBe(true)
    const [recorded] = await installs(app)
    expect(recorded?.kind).toBe('appimage')
    expect(recorded?.file.endsWith(join('pending-update', APPIMAGE))).toBe(true)
    expect(recorded?.sha256).toBe(sha256(PACKAGE))
    expect(state(userData)?.lastNotifiedVersion).toBe('v1.2.0')
    expect(requests.some((path) => /nightly|v1\.4\.0|v1\.3\.0/.test(path))).toBe(false)
    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('Download from GitHub opens the release page in a new tab and installs nothing', async () => {
  const { app, chrome } = await launched()
  try {
    await lookNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Download from GitHub')
    expect((await waitForTab(chrome, { address: 'https://github.com/OrivonBrowser/orivon-mvp/releases/tag/v1.2.0' })).ok).toBe(true)
    expect(await installs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('asks once per version: Not now is remembered and a second look is silent', async () => {
  const { app, userData } = await launched()
  try {
    await lookNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Not now')
    expect(await waitFor(() => state(userData)?.lastNotifiedVersion === 'v1.2.0')).toBe(true)
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await lookNow(app)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(await installs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('after Not now, Settings > About shows the release and Install update without pressing Check now', async () => {
  const { app, chrome } = await launched()
  try {
    await lookNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Not now')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    const page = await openAbout(app, chrome)
    const banner = page.locator('.banner', { hasText: 'Orivon 1.2.0 is available.' })
    await banner.waitFor()
    expect(await banner.locator('button', { hasText: 'Install update' }).count()).toBe(1)
    expect(await banner.locator('button', { hasText: 'Open release page' }).count()).toBe(1)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('raises no question for a package list whose signature does not match', async () => {
  const { app, userData } = await launched({ tamper: 'signature' })
  try {
    await lookNow(app)
    expect(await waitFor(() => requests.some((path) => path.endsWith('orivon-update.json.sig')))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(state(userData)?.lastNotifiedVersion).toBeUndefined()
    expect(await installs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('refuses a package that is not the one that was signed, says so, and installs nothing', async () => {
  const { app } = await launched({ tamper: 'package' })
  try {
    await lookNow(app)
    await waitQuestion(app)
    await answerQuestion(app, 'Install update')
    expect(await waitFor(async () => {
      try { return (await readQuestion(await waitQuestion(app, 2_000))).title === 'Orivon could not install the update' } catch { return false }
    })).toBe(true)
    const failed = await readQuestion(await waitQuestion(app))
    expect(failed.detail).toContain('does not match')
    expect([...failed.buttons].sort()).toEqual(['Close', 'Download from GitHub'])
    expect(await installs(app)).toEqual([])
    await answerQuestion(app, 'Close')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('a copy that cannot replace itself is offered the release page alone, with the reason', async () => {
  const { app } = await launched({ record: false })
  try {
    await lookNow(app)
    const said = await readQuestion(await waitQuestion(app))
    expect([...said.buttons].sort()).toEqual(['Download from GitHub', 'Not now'])
    expect(said.detail).toContain('source folder')
    await answerQuestion(app, 'Not now')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('Settings checks at once and its banner installs the release it found', async () => {
  const { app, chrome } = await launched()
  try {
    const page = await openAbout(app, chrome)
    expect(await page.locator('#row-updates-check input[type=checkbox]').isChecked()).toBe(true)
    await page.locator('#row-updates-now button').click()
    const banner = page.locator('.banner', { hasText: 'Orivon 1.2.0 is available.' })
    await banner.waitFor()
    expect(await banner.locator('button', { hasText: 'Open release page' }).count()).toBe(1)
    await banner.locator('button', { hasText: 'Install update' }).click()
    expect(await waitFor(async () => (await installs(app)).length === 1)).toBe(true)
    expect((await installs(app))[0]?.sha256).toBe(sha256(PACKAGE))
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('Settings of a run that cannot install shows the release page and the reason, never Install', async () => {
  const { app, chrome } = await launched({ record: false })
  try {
    const page = await openAbout(app, chrome)
    await page.locator('#row-updates-now button').click()
    const banner = page.locator('.banner', { hasText: 'Orivon 1.2.0 is available.' })
    await banner.waitFor()
    expect(await banner.locator('button', { hasText: 'Install update' }).count()).toBe(0)
    expect(await banner.textContent()).toContain('source folder')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

run('a private session never looks, asks or installs', async () => {
  const { app } = await launched({ args: ['--orivon-private'] })
  try {
    expect(await app.evaluate(() => typeof (globalThis as unknown as { __orivonDevUpdateCheckNow?: unknown }).__orivonDevUpdateCheckNow)).toBe('undefined')
    await delay(ABSENCE_SETTLE_MS)
    expect(requests.filter((path) => path.startsWith('/releases'))).toEqual([])
    expect(await questionGone(app)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
