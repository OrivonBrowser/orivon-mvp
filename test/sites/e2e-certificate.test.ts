// The certificate viewer in the running shell: a page's chain, validity and fingerprint read from the one
// verify proc, opened from the command and from the site-info popup, kept for a page that is open however many
// other hosts connect. The fixture's own certificate is accepted through a `certificate-error` listener
// the test adds in main. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both colour schemes.
import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttps } from 'node:https'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { overlayShown, runCommand, safely, shoot, waitOverlay } from '../support/auth-support.js'
import { clickAddressBarRetrying } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from '../support/launch-electron.mjs'
import { findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { launchShell, visit } from '../support/qa-helpers.js'

const TEST_TIMEOUT_MS = 120_000
const FLOOD = 205

let scratch = ''
let https: Server
let origin = ''
let port = 0
let pem = ''
let requests = 0

beforeAll(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'orivon-certificate-'))
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '365', '-subj', '/CN=127.0.0.1/O=Fixture Org', '-addext', 'subjectAltName=IP:127.0.0.1',
    '-keyout', join(scratch, 'key.pem'), '-out', join(scratch, 'cert.pem')], { stdio: 'ignore' })
  pem = readFileSync(join(scratch, 'cert.pem'), 'utf8')
  https = createHttps({ key: readFileSync(join(scratch, 'key.pem')), cert: pem }, (request, response) => {
    requests++
    response.setHeader('content-type', 'text/html')
    if (request.url?.startsWith('/flood') === true) {
      // One fetch to each of more hosts than the viewer remembers: the first host noted is the one forgotten.
      response.end(`<!doctype html><title>Flooding</title><script>
        (async () => {
          if (!sessionStorage.getItem('flooded')) {
            sessionStorage.setItem('flooded', '1')
            for (let i = 0; i < ${String(FLOOD)}; i++) { try { await fetch('https://h' + i + '.cert.test:${String(port)}/x', { mode: 'no-cors' }) } catch (e) {} }
          }
          document.title = 'Flooded'
        })()
      </script>`)
    } else {
      response.end('<!doctype html><title>Secure page</title><h1>Secure</h1>')
    }
  })
  await new Promise<void>((resolve) => { https.listen(0, '127.0.0.1', resolve) })
  port = (https.address() as AddressInfo).port
  origin = `https://127.0.0.1:${String(port)}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => { https.close(() => { resolve() }); https.closeAllConnections() })
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

async function start (): Promise<{ app: ElectronApplication, chrome: Page }> {
  const shell = await launchShell({ args: ['--host-resolver-rules=MAP *.cert.test 127.0.0.1, MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] })
  await shell.app.evaluate(({ app }) => {
    app.on('certificate-error', (event, _contents, _url, _error, _certificate, callback) => { event.preventDefault(); callback(true) })
  })
  return shell
}

const text = async (page: Page, selector: string): Promise<string> => (await page.locator(selector).first().innerText()).trim()

it('shows the certificate of the page, read from the verify proc, from the command', async () => {
  const { app, chrome } = await start()
  try {
    const x509 = new X509Certificate(pem)
    await visit(app, chrome, `${origin}/`)
    await runCommand(chrome, 'site.certificate')
    const viewer = await waitOverlay(app, 'certificate')
    await viewer.waitForSelector('.cert-grid')
    expect(await text(viewer, '.sheet-title')).toBe('Certificate for 127.0.0.1')
    // A chain of one has no tab strip.
    expect(await viewer.locator('.tab-btn').count()).toBe(0)
    const values = await viewer.locator('.cert-grid dd').allInnerTexts()
    const labels = await viewer.locator('.cert-grid dt').allInnerTexts()
    const field = (label: string): string => values[labels.indexOf(label)] ?? ''
    expect(field('Issued to')).toContain('127.0.0.1')
    expect(field('Issued to')).toContain('Fixture Org')
    expect(field('Issued by')).toContain('127.0.0.1')
    expect(field('Valid until')).toContain(String(new Date(x509.validTo).getFullYear()))
    expect(field('Valid from')).toContain(String(new Date(x509.validFrom).getFullYear()))
    expect(field('Valid until')).not.toContain('expired')
    expect(field('SHA-256 fingerprint').trim()).toBe(x509.fingerprint256)
    expect(field('Serial number').replace(/:/g, '').replace(/^0+/, '')).toBe(x509.serialNumber.replace(/^0+/, ''))
    await shoot(app, chrome, viewer, 'certificate')
    // Copying reports an outcome either way: a clipboard that stalls under a virtual display is reported, not waited on.
    await viewer.click('button:has-text("Copy certificate")')
    expect(await waitFor(async () => /Copied|Could not copy/.test(await viewer.locator('.cert-status').innerText()))).toBe(true)
    await safely(viewer.keyboard.press('Escape'))
    expect(await waitFor(async () => !(await overlayShown(app, 'certificate')))).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('opens from the Certificate row of the site-info popup, which gives way to it', async () => {
  const { app, chrome } = await start()
  try {
    await visit(app, chrome, `${origin}/`)
    await chrome.click('#web3-score-btn')
    expect(await waitFor(() => app.windows().some((w) => w.url().includes('/site-info/')))).toBe(true)
    const popup = app.windows().find((w) => w.url().includes('/site-info/')) as Page
    await popup.waitForSelector('.back-row')
    await popup.click('.back-row')
    await popup.waitForSelector('.certificate-row')
    expect(await text(popup, '.certificate-row')).toBe('Certificate')
    await shoot(app, chrome, popup, 'certificate-site-info-row')
    await popup.click('.certificate-row')
    const viewer = await waitOverlay(app, 'certificate')
    await viewer.waitForSelector('.cert-grid')
    expect(await text(viewer, '.sheet-title')).toBe('Certificate for 127.0.0.1')
    expect(await waitFor(() => !app.windows().some((w) => w.url().includes('/site-info/') && !w.isClosed()))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('offers no certificate for a page that did not come over https', async () => {
  const { app, chrome } = await start()
  try {
    await runCommand(chrome, 'site.certificate')
    await new Promise<void>((resolve) => { setTimeout(resolve, 600) })
    expect(await overlayShown(app, 'certificate')).toBe(false)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('keeps the certificate of the page on screen when more hosts connect than the viewer remembers', async () => {
  const { app, chrome } = await start()
  try {
    await visit(app, chrome, `${origin}/flood`)
    expect(await waitFor(async () => (await findChrome(app).locator('.tab.active .title').innerText()) === 'Flooded', 60_000)).toBe(true)
    await runCommand(chrome, 'site.certificate')
    const viewer = await waitOverlay(app, 'certificate')
    await viewer.waitForSelector('.cert-grid')
    expect(await text(viewer, '.sheet-title')).toBe('Certificate for 127.0.0.1')
    expect(await viewer.locator('.empty-state').count()).toBe(0)
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)

it('puts a sheet over a page whose certificate nobody vouches for, with no way on but back', async () => {
  const { app, chrome } = await launchShell()
  try {
    await clickAddressBarRetrying(chrome, `${origin}/`)
    const sheet = await waitOverlay(app, 'cert-error')
    await sheet.waitForSelector('.cert-error-text')
    expect(await text(sheet, '.sheet-title')).toBe('This site\'s certificate is not trusted')
    expect(await text(sheet, '.origin')).toBe(`127.0.0.1:${String(port)}`)
    expect(await text(sheet, '.cert-error-text')).toBe('The certificate was not issued by an authority this computer trusts.')
    expect(await sheet.locator('button').allInnerTexts()).toEqual(['Go back'])
    expect(await sheet.evaluate(() => document.activeElement?.textContent)).toBe('Go back')
    await shoot(app, chrome, sheet, 'certificate-error')
    // The page itself never loaded, and Go back leaves it.
    const requestsBefore = requests
    await safely(sheet.click('button:has-text("Go back")'))
    expect(await waitFor(async () => !(await overlayShown(app, 'cert-error')))).toBe(true)
    expect(requests).toBe(requestsBefore)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
