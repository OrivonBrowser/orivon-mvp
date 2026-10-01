// Scratch: whole-window captures of the sheets over a new tab. Never committed.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttps } from 'node:https'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication } from 'playwright'
import { overlayShown, setScheme, waitOverlay } from './auth-support.js'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from './launch-electron.mjs'
import { launchShell } from './qa-helpers.js'
import { delay, findChrome } from './smoke-helpers.mjs'

const OUT = process.env['SHOT_OUT'] ?? '/tmp/b3fix'
mkdirSync(OUT, { recursive: true })
let auth: Server
let authPort = 0
let tls: Server
let tlsPort = 0
let dir = ''

beforeAll(async () => {
  auth = createServer((_request, response) => {
    response.statusCode = 401
    response.setHeader('www-authenticate', 'Basic realm="Staging"')
    response.end('denied')
  })
  await new Promise<void>((resolve) => { auth.listen(0, '127.0.0.1', resolve) })
  authPort = (auth.address() as AddressInfo).port
  dir = mkdtempSync(join(tmpdir(), 'orivon-b3fix-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '30', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' })
  tls = createHttps({ key: readFileSync(join(dir, 'k.pem')), cert: readFileSync(join(dir, 'c.pem')) }, (_q, r) => { r.end('tls') })
  await new Promise<void>((resolve) => { tls.listen(0, '127.0.0.1', resolve) })
  tlsPort = (tls.address() as AddressInfo).port
})
afterAll(async () => {
  for (const s of [auth, tls]) await new Promise<void>((resolve) => { s.close(() => { resolve() }); s.closeAllConnections() })
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function capture (app: ElectronApplication, name: string): Promise<void> {
  const chrome = findChrome(app)
  for (const scheme of ['light', 'dark'] as const) {
    await setScheme(app, [chrome], scheme)
    await delay(500)
    const b = await app.evaluate(({ BaseWindow }) => BaseWindow.getAllWindows()[0]?.getBounds() ?? { x: 0, y: 0, width: 1280, height: 800 })
    execFileSync('import', ['-window', 'root', '-crop', `${String(b.width)}x${String(b.height)}+${String(Math.max(0, b.x))}+${String(Math.max(0, b.y))}`, '+repage', join(OUT, `${name}-${scheme}.png`)])
  }
}

it('auth sheet over a new tab', async () => {
  const { app, chrome } = await launchShell()
  try {
    await clickAddressBarRetrying(chrome, `http://127.0.0.1:${String(authPort)}/secret`)
    await waitOverlay(app, 'auth-sheet')
    await delay(600)
    console.info('FOCUS', JSON.stringify(await app.evaluate(async ({ webContents }) => await Promise.all(webContents.getAllWebContents().filter((w) => !w.isDestroyed() && /newtab|overlay=auth|localhost|index.html/.test(w.getURL())).map(async (w) => ({ url: w.getURL().slice(0, 70), focused: w.isFocused(), page: await Promise.race([w.executeJavaScript('document.hasFocus() + " " + (document.documentElement.dataset.away ?? "-")', true), new Promise((r) => setTimeout(() => r('timeout'), 1500))]).catch(() => 'n/a') })))))) 
    console.info('ADDRESS', await chrome.locator('#address-display').innerText(), '| TAB', await chrome.locator('.tab.active .title').innerText())
    await capture(app, 'auth-over-ntp')
  } finally {
    await closeElectron(app)
  }
}, 120_000)

it('certificate sheet over a new tab', async () => {
  const { app, chrome } = await launchShell()
  try {
    await clickAddressBarRetrying(chrome, `https://127.0.0.1:${String(tlsPort)}/`)
    expect(await overlayShown(app, 'cert-error') || await (async () => { await waitOverlay(app, 'cert-error'); return true })()).toBe(true)
    await delay(600)
    console.info('BACKGROUNDS', JSON.stringify([...(await app.evaluate(() => [...((globalThis as { __orivonDevViewBackgrounds?: Map<number, string> }).__orivonDevViewBackgrounds ?? new Map()).entries()]))]))
    await capture(app, 'cert-over-ntp')
  } finally {
    await closeElectron(app)
  }
}, 120_000)
