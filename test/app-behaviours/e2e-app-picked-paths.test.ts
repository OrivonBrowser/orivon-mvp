// What a page that bundles the `electron` and `fs` shims can count on from `dialog`: the paths it returns are
// stand-ins that `fs` reads and writes directly (catalogue: Files and storage). The OS picker cannot be clicked
// headless, so main's `dialog.showOpenDialog` is replaced and answers a temp path, which is exactly where the
// broker's picker asks; the save picker is the page's own `showSaveFilePicker`, replaced here (a refusal until the save scenario, then
// a handle into the page's private storage), because a real one opens a native dialog, which is never driven. Everything after
// the picker is the real shell, preload, broker and disk.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-picked-paths.test.ts
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { nativeDialogsAsked, stubNativeDialogs } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'
import { ABSENCE_SETTLE_MS, delay } from '../support/smoke-helpers.mjs'
import { bundleForApp } from '../node-runtime/pinned-app.js'

const PAGE = '<!doctype html><title>picked paths</title><body><button id="go">go</button><script src="/app.js"></script></body>'
let server: AppServer
let scratch: string

beforeAll(async () => {
  const script = new TextDecoder().decode(await bundleForApp(fileURLToPath(new URL('./picked-paths-entry.ts', import.meta.url))))
  server = await startAppServer({ '/': { type: 'text/html; charset=utf-8', body: PAGE }, '/app.js': { type: 'text/javascript', body: script } })
  scratch = mkdtempSync(join(tmpdir(), 'orivon-picked-'))
})
afterAll(async () => {
  await server.close()
  rmSync(scratch, { recursive: true, force: true })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Probe = Record<string, (...args: unknown[]) => Promise<unknown>>
const probe = async (view: Page, name: string, ...args: unknown[]): Promise<unknown> =>
  await view.evaluate(async ([call, values]) => await (window as unknown as { probe: Probe }).probe[call as string]!(...(values as unknown[])), [name, args] as const)
// Waits inside the page: an evaluate from the driver counts as a user gesture, so polling with one would keep a gesture alive.
const results = async (view: Page, key: string): Promise<Record<string, unknown>> => {
  await view.waitForFunction((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k] !== undefined, key, { timeout: 30_000 })
  const last = await view.evaluate((k) => (window as unknown as { __r: Record<string, unknown> }).__r[k], key)
  expect(typeof last, `the page's ${key} scenario: ${JSON.stringify(last)}`).toBe('object')
  return last as Record<string, unknown>
}
/** Sets the scenario and presses the page's button as the person does, so the dialog is called inside a click. */
const clickScenario = async (view: Page, scenario: string): Promise<void> => {
  await view.evaluate((name) => { (window as unknown as { __scenario: string }).__scenario = name }, scenario)
  await view.click('#go')
}
const loaded = async (view: Page): Promise<void> => { await view.waitForFunction(() => (window as unknown as { probe?: unknown }).probe !== undefined) }

it('[app:electron-dialog-paths-read-and-write-the-pick] [app:user-picked-file-and-folder-handles] a path from dialog.showOpenDialog or showSaveDialog reads and writes the picked file or folder through fs, with no copy and no host path, and a path from before a reload fails cleanly', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('electron dialog picked paths', async (check) => {
      const chosen = join(scratch, 'My notes (final).v2.txt')
      const folder = join(scratch, 'folder')
      writeFileSync(chosen, 'picked file contents')
      mkdirSync(folder)
      writeFileSync(join(folder, 'a.txt'), 'alpha')
      writeFileSync(join(folder, 'b.txt'), 'beta')
      await grantApp(app, server.origin, appManifest('electron-dialog-paths', { fs: { quotaBytes: 1_048_576 } }), [{ capability: 'fs', patterns: [] }])
      await stubNativeDialogs(app, { open: [chosen] })
      const view = await visit(app, chrome, `${server.origin}/`)
      await loaded(view)

      await probe(view, 'withoutClickLater', 6_000)
      const noClick = await results(view, 'withoutClick')
      check('[app:electron-dialog-paths-read-and-write-the-pick] without a click the open dialog rejects naming the click, and no picker was shown', /^ElectronShimError:invalid-usage:.*click or key press/.test(String(noClick['open'])) && (await nativeDialogsAsked(app)).length === 0, `${String(noClick['open'])} ${JSON.stringify(await nativeDialogsAsked(app))}`)
      check('[app:electron-dialog-paths-read-and-write-the-pick] and so does the save dialog when the page\'s showSaveFilePicker refuses with a SecurityError, as the browser\'s does without a gesture (the spec\'s stub, so no native window can open)',  /^ElectronShimError:invalid-usage:.*click or key press/.test(String(noClick['save'])), JSON.stringify(noClick))

      await clickScenario(view, 'openFile')
      const file = await results(view, 'openFile')
      check('[app:electron-dialog-paths-read-and-write-the-pick] showOpenDialog answers a stand-in path under /orivon/picked, never the host path', typeof file['path'] === 'string' && /^\/orivon\/picked\/[0-9a-f]+\/[^/]+$/.test(file['path']) && !String(file['path']).includes(scratch), JSON.stringify(file))
      check('[app:electron-dialog-paths-read-and-write-the-pick] the stand-in path ends in the picked file\'s real name, so path.basename and path.extname work on it, and nothing of the folder above it appears', String(file['path']).endsWith('/My notes (final).v2.txt') && file['base'] === 'My notes (final).v2.txt' && file['ext'] === '.txt' && !String(file['path']).includes('orivon-picked-'), JSON.stringify(file))
      check('[app:electron-dialog-paths-read-and-write-the-pick] stat, readFile and createReadStream on it give the picked file itself', file['size'] === 20 && file['isFile'] === true && file['read'] === 'picked file contents' && file['streamed'] === 'picked file contents', JSON.stringify(file))
      check('[app:electron-dialog-paths-read-and-write-the-pick] writeFile on it rewrites the file on disk, and nothing was copied into the app\'s files', file['again'] === 'rewritten by the app' && readFileSync(chosen, 'utf8') === 'rewritten by the app' && file['plain'] === 'in the app files', JSON.stringify(file))

      await stubNativeDialogs(app, { open: [folder] })
      await clickScenario(view, 'openFolder')
      const dir = await results(view, 'openFolder')
      check('[app:electron-dialog-paths-read-and-write-the-pick] a picked folder lists and reads through its stand-in path', JSON.stringify(dir['names']) === JSON.stringify(['a.txt', 'b.txt']) && dir['text'] === 'alpha' && /^\/orivon\/picked\/[0-9a-f]+$/.test(String(dir['root'])), JSON.stringify(dir))
      check('[app:electron-dialog-paths-read-and-write-the-pick] and mkdir, writeFile and createWriteStream inside it land in the real folder', readFileSync(join(folder, 'out', 'deep', 'b.txt'), 'utf8') === 'written into the folder' && readFileSync(join(folder, 'streamed.txt'), 'utf8') === 'streamed into the folder' && JSON.stringify(dir['nested']) === JSON.stringify([['deep', true]]), JSON.stringify({ dir, files: readdirSync(folder) }))
      const copies = dir['copies'] as { temp: string, intoAppFiles: string, outOfTheFolder: string }
      const tempName = String(copies.temp).split('/').at(-1) ?? ''
      check('[app:electron-dialog-paths-read-and-write-the-pick] copyFile and cp inside the folder land in the real folder, and cp copies a tree from it into the app\'s files', readFileSync(join(folder, 'a-copy.txt'), 'utf8') === 'alpha' && readFileSync(join(folder, 'out-copy', 'deep', 'b.txt'), 'utf8') === 'written into the folder' && copies.intoAppFiles === 'written into the folder', JSON.stringify({ copies, files: readdirSync(folder) }))
      check('[app:electron-dialog-paths-read-and-write-the-pick] mkdtemp inside the folder makes a new real folder under the picked one, and a copy to a path beside the folder fails', /^tmp-[A-Za-z0-9]+$/.test(tempName) && readFileSync(join(folder, tempName, 'x.txt'), 'utf8') === 'in a temp folder in the pick' && /^(EACCES|ENOENT)/.test(copies.outOfTheFolder), JSON.stringify({ copies, files: readdirSync(folder) }))
      const escapes = dir['escapes'] as Record<string, string>
      check('[app:electron-dialog-paths-read-and-write-the-pick] a path that climbs out of the folder, or leaves for the host, reads nothing', Object.values(escapes).every((outcome) => /^(EACCES|ENOENT)/.test(outcome)), JSON.stringify(escapes))

      await clickScenario(view, 'save')
      const saved = await results(view, 'save')
      check('[app:electron-dialog-paths-read-and-write-the-pick] showSaveDialog passes the default name to the browser\'s picker and answers a stand-in path ending in the saved name', saved['suggestedName'] === 'export.json' && /^\/orivon\/picked\/[0-9a-f]+\/export\.json$/.test(String(saved['filePath'])) && saved['canceled'] === false, JSON.stringify(saved))
      check('[app:electron-dialog-paths-read-and-write-the-pick] writeFile and appendFile to it are in the saved file once the calls settle', saved['onDisk'] === '{"saved":true}\n' && saved['readBack'] === '{"saved":true}\n', JSON.stringify(saved))

      const stalePaths = [String(file['path']), String(dir['root']), String(saved['filePath'])]
      await view.reload()
      await loaded(view)
      for (const stale of stalePaths) {
        const read = String(await probe(view, 'staleRead', stale))
        const stream = String(await probe(view, 'staleStream', stale))
        check('[app:electron-dialog-paths-read-and-write-the-pick] after a reload the old path fails as ENOENT and says the pick must be made again, for a call and for a stream', /^ENOENT: .*pick.*(reload|revoked).*pick/i.test(read) && /^ENOENT/.test(stream), `${stale}: ${read} | ${stream}`)
      }
      check('[app:electron-dialog-paths-read-and-write-the-pick] and the synchronous form fails by saying a pick has no synchronous wire', /^ENOSYS: .*no synchronous wire/.test(String(await probe(view, 'syncRead', stalePaths[0]))))
      await delay(ABSENCE_SETTLE_MS)
      check('[app:electron-dialog-paths-read-and-write-the-pick] the file the reload left behind is untouched', readFileSync(chosen, 'utf8') === 'rewritten by the app')
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
