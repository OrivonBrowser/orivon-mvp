// A file opened from this computer asks before it may use Orivon permissions, and what it is allowed stays with
// that exact file. The question is a warning that needs two presses (one grants nothing); after the second the file's
// capabilities, its `id` key, its saved files and its inline script work; after a restart on the same profile they are
// all back with no question; a sibling file is asked again. Real presses on the real panel, a real address bar.
// Runs on a binary whose file-protocol fuse is off (`npm run install:electron`) and on the e2e build:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-local-file.test.ts
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput, profileDirOf } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { ABSENCE_SETTLE_MS, delay, waitFor } from '../support/smoke-helpers.mjs'

/** Longer than the 1.5 s a second press has to follow the first. */
const DOUBLE_PRESS_LATE_MS = 1700

let dir: string
const urlOf = (name: string): string => pathToFileURL(join(dir, name)).href
const ownPartition = (key: string): string => `persist:local-${createHash('sha256').update(key, 'utf8').digest('hex')}`

const MANIFEST = JSON.stringify({
  orivonApiVersion: 0, id: 'dev.example.local-notes', name: 'Local notes', version: '1.0.0', entry: 'app.html',
  capabilities: { fs: { quotaBytes: 1_048_576 }, id: { curves: ['P-256'] } }
})

const PAGE = (title: string): string => `<!doctype html><title>${title}</title><link rel="orivon-manifest" href="orivon.json"><body>
<script>document.body.dataset.inline = 'ran'</script>
<script src="app.js"></script>`

/** The page's own script: what it holds, its key, a file it saved; written to the body for the spec to read. */
const APP_JS = `(async () => {
  const result = { inline: document.body.dataset.inline || 'none', orivon: typeof window.orivon }
  try { result.grants = (await window.orivon.app.grants()).map((grant) => grant.capability).sort() } catch (error) { result.grants = 'err:' + (error && error.code) + ':' + (error && error.message) }
  if (Array.isArray(result.grants) && result.grants.includes('id')) {
    const key = await window.orivon.id.publicKey({ curve: 'P-256' })
    result.publicKey = Array.from(key).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  }
  if (Array.isArray(result.grants) && result.grants.includes('fs')) {
    result.fs = await window.orivon.fs.readFile('note.txt').then((bytes) => new TextDecoder().decode(bytes), async () => {
      await window.orivon.fs.writeFile('note.txt', new TextEncoder().encode('kept for this file'))
      return 'wrote'
    })
  }
  document.body.dataset.result = JSON.stringify(result)
})()`

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'orivon-local-app-')))
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'app.html'), PAGE('local app'))
  writeFileSync(join(dir, 'sibling.html'), PAGE('local sibling'))
  writeFileSync(join(dir, 'app.js'), APP_JS)
  writeFileSync(join(dir, 'orivon.json'), MANIFEST)
})

afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Seen { readonly inline: string, readonly orivon: string, readonly grants: string[] | string, readonly publicKey?: string, readonly fs?: string }

/** The result the file's own script wrote, once the page for `url` holds one that satisfies `wanted`. */
async function seenAt (app: ElectronApplication, url: string, wanted: (seen: Seen) => boolean, timeoutMs = 40_000): Promise<Seen> {
  let found: Seen | undefined
  const ok = await waitFor(async () => {
    for (const page of app.windows().filter((window) => window.url().split('#')[0] === url && !window.isClosed())) {
      const raw = await page.evaluate(() => document.body?.dataset['result']).catch(() => undefined)
      if (raw === undefined) continue
      const seen = JSON.parse(raw) as Seen
      if (wanted(seen)) { found = seen; return true }
    }
    return false
  }, timeoutMs)
  expect(ok, `no page at ${url} reported the wanted result`).toBe(true)
  return found as Seen
}

/** The partition the page showing `url` is in, as a name `session.fromPartition` gives the same session for. */
async function partitionOf (app: ElectronApplication, url: string, names: string[]): Promise<string> {
  return await app.evaluate(({ session, webContents }, { target, candidates }) => {
    const wc = webContents.getAllWebContents().find((candidate) => !candidate.isDestroyed() && candidate.getURL().split('#')[0] === target)
    return wc === undefined ? 'no page' : candidates.find((name) => wc.session === session.fromPartition(name)) ?? 'other'
  }, { target: url, candidates: names })
}

it('[app:local-file-grant] asks with a warning and a double press, grants to that exact file, and finds it all again after a restart', async () => {
  const appUrl = urlOf('app.html')
  const siblingUrl = urlOf('sibling.html')
  const partitions = ['persist:orivon-local-files', ownPartition(appUrl)]
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  let live: ElectronApplication | undefined = first.app
  try {
    await stubNativeDialogs(first.app)
    void visit(first.app, first.chrome, appUrl)
    const panel = await waitQuestion(first.app)
    const said = await readQuestion(panel)
    expect(said.title).toBe('Let a file on this computer use Orivon permissions?')
    expect(said.warning).toBe(true)
    expect(said.message).toContain('Orivon cannot check files on your computer')
    expect(said.message).toContain('Whoever can change this file can change what it does')
    expect(said.buttons).toEqual(["Don't allow", 'Allow (press twice)'])
    expect(said.origin).toContain('app.html')

    // One press answers nothing and records nothing, and a second one that comes after the window is a first press again.
    // The pointer reaches the button during the guard and rests there: it arms once the guard has ended, with no move.
    const allow = panel.locator('.q .btn-row .btn[data-button="1"]')
    await allow.hover()
    await panel.waitForSelector('.q:not(.arming)')
    await allow.click()
    await delay(DOUBLE_PRESS_LATE_MS)
    expect(await questionGone(first.app)).toBe(false)
    await allow.click()
    await delay(100)
    expect(await questionGone(first.app)).toBe(false)
    expect(existsSync(join(profile, 'local-file-apps.json'))).toBe(false)

    // The second press, within the window of the first, allows.
    await allow.click().catch(() => undefined)
    expect(await waitFor(() => existsSync(join(profile, 'local-file-apps.json')))).toBe(true)
    expect((JSON.parse(readFileSync(join(profile, 'local-file-apps.json'), 'utf8')) as { files: string[] }).files).toEqual([appUrl])

    const granted = await seenAt(first.app, appUrl, (seen) => Array.isArray(seen.grants) && seen.grants.length === 2)
    expect(granted).toMatchObject({ inline: 'ran', orivon: 'object', grants: ['fs', 'id'], fs: 'wrote' })
    expect(granted.publicKey).toMatch(/^[0-9a-f]{66,130}$/)
    expect(await partitionOf(first.app, appUrl, partitions)).toBe(partitions[1])
    expect(mainOutput(first.app)).not.toContain('uncaught exception')
    expect(await noNativeDialogs(first.app)).toEqual([])
    await closeElectron(first.app, { keepProfile: true })
    live = undefined

    const second = await launchShell({ reuseProfile: profile })
    live = second.app
    await stubNativeDialogs(second.app)
    void visit(second.app, second.chrome, appUrl)
    const again = await seenAt(second.app, appUrl, (seen) => Array.isArray(seen.grants) && seen.grants.length === 2)
    expect(again).toMatchObject({ inline: 'ran', grants: ['fs', 'id'], fs: 'kept for this file' })
    // The key itself stays the same across a restart only where an OS keyring holds the seed; this run has none, so only its shape is read.
    expect(again.publicKey).toMatch(/^[0-9a-f]{66,130}$/)
    expect(await questionGone(second.app)).toBe(true)
    expect(await partitionOf(second.app, appUrl, partitions)).toBe(partitions[1])

    // A sibling file is another origin: it is asked, and declining leaves it holding nothing and unrecorded.
    void visit(second.app, second.chrome, siblingUrl)
    await waitQuestion(second.app)
    await answerQuestion(second.app, "Don't allow")
    const declined = await seenAt(second.app, siblingUrl, (seen) => Array.isArray(seen.grants))
    expect(declined.grants).toEqual([])
    expect((JSON.parse(readFileSync(join(profile, 'local-file-apps.json'), 'utf8')) as { files: string[] }).files).toEqual([appUrl])
    expect(await noNativeDialogs(second.app)).toEqual([])
    expect(mainOutput(second.app)).not.toContain('uncaught exception')
  } finally {
    if (live !== undefined) await closeElectron(live)
    await rm(profile, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS * 2)

/** Opens the privacy page of Settings and returns it. */
async function privacyPage (app: ElectronApplication, chrome: Page): Promise<Page> {
  await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/privacy') })
  let found: Page | undefined
  expect(await waitFor(() => { found = app.windows().find((window) => window.url().includes('/settings') && !window.isClosed()); return found !== undefined })).toBe(true)
  return found as Page
}

it('lists the allowed file on the privacy page, and Delete data takes back its grants, its saved files and its record', async () => {
  const appUrl = urlOf('app.html')
  const { app, chrome } = await launchShell()
  const profile = profileDirOf(app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  try {
    await stubNativeDialogs(app)
    void visit(app, chrome, appUrl)
    const panel = await waitQuestion(app)
    await panel.waitForSelector('.q:not(.arming)')
    const allow = panel.locator('.q .btn-row .btn[data-button="1"]')
    await allow.hover()
    await allow.click()
    await allow.click().catch(() => undefined)
    await seenAt(app, appUrl, (seen) => Array.isArray(seen.grants) && seen.grants.length === 2)
    const folder = join(profile, 'app-data', createHash('sha256').update(appUrl, 'utf8').digest('hex'))
    expect(await waitFor(() => existsSync(folder))).toBe(true)

    const page = await privacyPage(app, chrome)
    const row = page.locator('#local-files .lf-row')
    await row.first().waitFor({ timeout: 20_000 })
    expect(await row.first().innerText()).toContain('app.html')
    // Delete asks twice, like every deleting button on the page.
    await row.first().locator('button').click()
    await page.locator('#local-files .lf-row .btn.armed').click()
    expect(await waitFor(() => !existsSync(folder))).toBe(true)
    expect(await waitFor(() => (JSON.parse(readFileSync(join(profile, 'local-file-apps.json'), 'utf8')) as { files: string[] }).files.length === 0)).toBe(true)
    await page.locator('#local-files .empty-state').waitFor({ timeout: 20_000 })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
