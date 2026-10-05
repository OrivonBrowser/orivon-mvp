// The two notices a page shown in a <webview> gives its app (ADR-0047),
// against the real shell and the real broker: a window the page asks for
// (window.open, a target link, a modifier click, a posted form) and a
// download (an attachment, one after a redirect, a blob: one) each reach the
// app as a bubbling `orivon-popup` / `orivon-download` event on the element,
// once, with the right detail, while nothing opens and no file is written.
// Also what the shell does with a shown page's navigation to a scheme
// Chromium does not know (A306).
//
// The shown sites are two loopback servers this file starts itself, on ports
// no other e2e file uses: 8961 (granted) and 8962 (never granted). Clicks are
// real input events sent to the guest, never a script-made click, because a
// popup and a download depend on a user gesture.
//
// Run with `npm run test:e2e`, or directly:
//   node scripts/build-e2e.mjs && npx vitest run --config test/vitest.e2e.config.ts test/capabilities/e2e-embed-events.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { assertNoElectronSurvivors, launchElectron } from '../support/launch-electron.mjs'
import { ABSENCE_SETTLE_MS, delay, evaluateRetrying, HERMETIC_RESOLVER, waitFor } from '../support/smoke-helpers.mjs'
import { closeElectronApp, forwardOutput, killChild, navigateToFixture, runPhase, waitForTcpReady } from '../support/e2e-helpers.js'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { HOST, STATIC_PORT } from '../apps/fixture/config.mjs'
import { embedPartitionFor } from '../../src/main/embed/embed-guard.js'
import type { DevGrantRequest } from '../../src/main/dev/dev-grant.js'
import type { EmbedDownload, EmbedPopup, Grant, Manifest } from '../../src/contracts/index.js'
import { LIMITS } from '../../src/contracts/index.js'

const FIXTURE_DIR = fileURLToPath(new URL('../apps/fixture/', import.meta.url)).replace(/[/\\]$/, '')
const FIXTURE_ORIGIN = `http://${HOST}:${STATIC_PORT}`
const SITE_PORT = 8961
const OTHER_PORT = 8962
const SITE_ORIGIN = `http://${HOST}:${SITE_PORT}`
const OTHER_ORIGIN = `http://${HOST}:${OTHER_PORT}`
const TEST_TIMEOUT_MS = 180_000
const EVENT_WAIT_MS = 10_000
const STEP_TIMEOUT_MS = 20_000
/** An action's event is heard once: this long after the first one, nothing more must have come. */
const SETTLE_MS = 800

/** File names no other run and no person's Downloads folder holds, so their absence there proves nothing was kept. */
const RUN_ID = `orivon-embed-events-${process.pid}-${Date.now()}`
const FILE_NAME = `${RUN_ID}.bin`
const BLOB_NAME = `${RUN_ID}.txt`
const FILE_BODY = 'twelve bytes'

/** One line of the shown page: a fixed box at a known place, so a click at its middle finds it. */
const ROWS = ['blank', 'plain', 'named', 'post', 'download', 'redirect', 'blob', 'open', 'features', 'custom', 'foreign', 'ask'] as const
type Row = typeof ROWS[number]
const ROW_HEIGHT = 40
const rowMiddle = (row: Row): { x: number, y: number } => ({ x: 100, y: ROWS.indexOf(row) * ROW_HEIGHT + ROW_HEIGHT / 2 })

function shownPage (): string {
  const box = (row: Row, inner: string): string =>
    `<div id="${row}" style="position:absolute;left:0;width:200px;top:${ROWS.indexOf(row) * ROW_HEIGHT}px;height:${ROW_HEIGHT}px;line-height:${ROW_HEIGHT}px;background:#ddd">${inner}</div>`
  const link = (attrs: string, text: string): string => `<a ${attrs} style="display:block;height:100%">${text}</a>`
  return `<!doctype html><html><head><title>shown</title></head><body style="margin:0">
${box('blank', link('href="/popup-target" target="_blank"', 'blank'))}
${box('plain', link('href="/plain-target"', 'plain'))}
${box('named', link('href="/named-target" target="pane"', 'named'))}
${box('post', '<form method="post" action="/posted" target="_blank" style="height:100%"><input type="hidden" name="a" value="1"><button type="submit" style="width:100%;height:100%">post</button></form>')}
${box('download', link(`href="/${FILE_NAME}"`, 'download'))}
${box('redirect', link('href="/go"', 'redirect'))}
${box('blob', link(`id="bloblink" download="${BLOB_NAME}" href="#"`, 'blob'))}
${box('open', '<button id="openbtn" style="width:100%;height:100%" onclick="window.open(\'/from-script?x=1\')">open</button>')}
${box('features', '<button style="width:100%;height:100%" onclick="window.open(\'/sized\', \'sized\', \'width=300,height=200\')">features</button>')}
${box('custom', link('href="foo://x/y"', 'custom'))}
${box('foreign', link(`href="${OTHER_ORIGIN}/${FILE_NAME}"`, 'foreign'))}
${box('ask', '<button style="width:100%;height:100%" onclick="window.asked = confirm(\'the shown page asks\')">ask</button>')}
<script>
  var blob = new Blob(['made by the page'], { type: 'text/plain' });
  document.getElementById('bloblink').href = URL.createObjectURL(blob);
</script>
</body></html>`
}

function shownSite (): Server {
  return createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(shownPage())
    } else if (req.url === `/${FILE_NAME}`) {
      res.writeHead(200, { 'content-type': 'application/x-orivon-test', 'content-disposition': `attachment; filename="${FILE_NAME}"`, 'content-length': String(FILE_BODY.length) })
      res.end(FILE_BODY)
    } else if (req.url === '/go') {
      res.writeHead(302, { location: `/${FILE_NAME}` })
      res.end()
    } else {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<!doctype html><title>${req.method} ${req.url}</title>`)
    }
  })
}

/** The other origin the app never granted: it serves one attachment. */
function otherSite (): Server {
  return createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/x-orivon-test', 'content-disposition': `attachment; filename="${FILE_NAME}"` })
    res.end(FILE_BODY)
  })
}

let staticServer: ChildProcess
const site = shownSite()
const other = otherSite()

beforeAll(async () => {
  staticServer = spawn(process.execPath, [join(FIXTURE_DIR, 'serve.mjs')], { stdio: 'pipe' })
  forwardOutput('fixture-server', staticServer)
  await Promise.all([
    new Promise<void>((resolve) => { site.listen(SITE_PORT, HOST, resolve) }),
    new Promise<void>((resolve) => { other.listen(OTHER_PORT, HOST, resolve) })
  ])
  await Promise.all([waitForTcpReady(HOST, STATIC_PORT, 10_000), waitForTcpReady(HOST, SITE_PORT, 10_000), waitForTcpReady(HOST, OTHER_PORT, 10_000)])
}, 15_000)

afterAll(async () => {
  await killChild(staticServer)
  await Promise.all([site, other].map(async (server) => await new Promise<void>((resolve) => { server.close(() => resolve()) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

function manifest (): Manifest {
  return {
    orivonApiVersion: 0,
    id: 'app.orivon.embed-events-e2e',
    name: 'Orivon embed events e2e fixture',
    version: '1.0.0',
    entry: '/index.html',
    capabilities: { web: { embed: { origins: [SITE_ORIGIN] } } }
  }
}

/** What the app page keeps: every event its one listener on `document` heard, and each element's `will-navigate` addresses. */
interface Heard {
  readonly name: string
  readonly detail: EmbedPopup | EmbedDownload
  readonly bubbles: boolean
  readonly composed: boolean
  /** 1 or 2: the element the event's target was; 0 for neither. */
  readonly element: number
  /** `detail` is an ordinary object of the page's own world, not a bridge proxy. */
  readonly plainObject: boolean
}
interface Element2 { getWebContentsId: () => number, executeJavaScript: (code: string) => Promise<unknown> }
interface PageState {
  __embedHeard: Heard[]
  __embedNavigations: string[]
  __embedOwn: string[]
  __embedView: Element2
  __embedLong: string[]
}

type Chrome = Awaited<ReturnType<typeof navigateToFixture>>

/** A click at `point` inside the shown page, as input the renderer takes for a person's: a user gesture, and any held modifier. */
async function clickGuest (app: ElectronApplication, guestId: number, point: { x: number, y: number }, modifiers: string[] = []): Promise<void> {
  await app.evaluate(({ webContents }, args) => {
    const guest = webContents.fromId(args.guestId)
    if (guest === undefined) throw new Error('no guest')
    const at = { x: args.x, y: args.y, modifiers: args.modifiers as Array<'control'> }
    guest.sendInputEvent({ type: 'mouseMove', ...at })
    guest.sendInputEvent({ type: 'mouseDown', ...at, button: 'left', clickCount: 1 })
    guest.sendInputEvent({ type: 'mouseUp', ...at, button: 'left', clickCount: 1 })
  }, { guestId, ...point, modifiers })
}

/**
 * Runs `act`, then returns what the app's listener heard: waits for the
 * first event, then a settle so a second would show. `expectAtLeast` 0 is
 * for an absence, which needs the longer settle.
 */
async function heardAfter (view: Chrome, act: () => Promise<void>, expectAtLeast = 1): Promise<Heard[]> {
  await evaluateRetrying(view, () => { (window as unknown as PageState).__embedHeard.length = 0 })
  await act()
  await waitFor(async () => await evaluateRetrying(view, () => (window as unknown as PageState).__embedHeard.length) >= expectAtLeast, EVENT_WAIT_MS)
  await delay(expectAtLeast === 0 ? ABSENCE_SETTLE_MS : SETTLE_MS)
  return await evaluateRetrying(view, () => (window as unknown as PageState).__embedHeard.slice())
}

const popupOf = (heard: Heard[]): EmbedPopup | undefined => heard.length === 1 && heard[0]?.name === 'orivon-popup' ? heard[0].detail as EmbedPopup : undefined
const downloadOf = (heard: Heard[]): EmbedDownload | undefined => heard.length === 1 && heard[0]?.name === 'orivon-download' ? heard[0].detail as EmbedDownload : undefined
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

it(
  '[app:webview-popup-reaches-the-app] a page shown in a <webview> asks for a window or starts a download, and its app hears one bubbling event each while nothing opens ' +
  'and no file is written; an unknown scheme in a shown page is heard by the element and never offered to another program',
  async () => {
    await runPhase('web.embed events e2e', async (check) => {
      const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      try {
        const grantOutcome = await app.evaluate(async (_electron, request: DevGrantRequest) => {
          const hook = (globalThis as unknown as { __orivonDevGrant?: (r: DevGrantRequest) => Promise<Grant> }).__orivonDevGrant
          if (typeof hook !== 'function') return { installed: false as const }
          return { installed: true as const, grant: await hook(request) }
        }, { origin: FIXTURE_ORIGIN, manifest: manifest(), capability: 'web.embed', patterns: [SITE_ORIGIN] } satisfies DevGrantRequest)
        check('the developer-only grant hook is installed in this build', grantOutcome.installed)
        if (!grantOutcome.installed) throw new Error('dev-grant hook missing -- was this built via npm run test:e2e?')

        const view = await navigateToFixture(app, `${FIXTURE_ORIGIN}/`, 'Orivon fixture app')
        const longAddress = (extra: number): string => `window.open('/long?' + 'a'.repeat(${LIMITS.embedEventUrlBytes + extra - `${SITE_ORIGIN}/long?`.length}))`
        await view.evaluate((scripts: string[]) => { (window as unknown as PageState).__embedLong = scripts }, [longAddress(0), longAddress(1)])

        // The app page: two <webview>s on one shown page, one listener on `document` for both events, and
        // each element's own `will-navigate` (neither element carries an `allowpopups` attribute).
        const setup = await evaluateRetrying(view, async () => {
          const page = window as unknown as PageState
          page.__embedHeard = []
          page.__embedNavigations = []
          page.__embedOwn = []
          const make = (): HTMLElement & Element2 & { src: string } => {
            const el = document.createElement('webview') as HTMLElement & Element2 & { src: string }
            el.src = `${location.protocol}//${location.hostname}:8961/`
            el.style.width = '640px'
            el.style.height = '520px'
            return el
          }
          const first = make()
          const second = make()
          const loaded = (el: HTMLElement): Promise<string> => new Promise((resolve) => {
            el.addEventListener('did-finish-load', () => { resolve('finished') })
            setTimeout(() => { resolve('timeout') }, 15_000)
          })
          const both = Promise.all([loaded(first), loaded(second)])
          first.addEventListener('will-navigate', (event) => { page.__embedNavigations.push((event as unknown as { url: string }).url) })
          second.addEventListener('orivon-popup', () => { page.__embedOwn.push('second heard its own') })
          for (const name of ['orivon-popup', 'orivon-download']) {
            document.addEventListener(name, (event) => {
              const custom = event as CustomEvent<EmbedPopup | EmbedDownload>
              page.__embedHeard.push({
                name: event.type,
                detail: JSON.parse(JSON.stringify(custom.detail)) as EmbedPopup | EmbedDownload,
                bubbles: event.bubbles,
                composed: event.composed,
                element: event.target === first ? 1 : event.target === second ? 2 : 0,
                plainObject: Object.getPrototypeOf(custom.detail) === Object.prototype
              })
            })
          }
          document.body.append(first, second)
          page.__embedView = first
          const outcomes = await both
          return { outcomes, guestIds: [first.getWebContentsId(), second.getWebContentsId()] }
        })
        check('both shown pages load', setup.outcomes.every((outcome: string) => outcome === 'finished'), JSON.stringify(setup))
        const [guestId, secondGuestId] = setup.guestIds as [number, number]

        // What the shell cancels: every download, counted at the embed session; every window, counted at the process.
        await app.evaluate(({ session }, partition) => {
          const counter = { downloads: 0 };
          (globalThis as unknown as { __embedCounter: typeof counter }).__embedCounter = counter
          session.fromPartition(partition).on('will-download', () => { counter.downloads += 1 })
        }, embedPartitionFor(FIXTURE_ORIGIN))
        const surface = async (): Promise<{ contents: number, windows: number, playwright: number }> => {
          const counted = await app.evaluate(({ webContents, BaseWindow }) => ({ contents: webContents.getAllWebContents().length, windows: BaseWindow.getAllWindows().length }))
          return { ...counted, playwright: app.windows().length }
        }
        const surfaceBefore = await surface()
        const downloadsDir = await app.evaluate(({ app: electronApp }) => electronApp.getPath('downloads'))
        const keptFiles = (): string[] => {
          try { return readdirSync(downloadsDir).filter((name) => name.includes(RUN_ID)) } catch { return [] }
        }

        // ---- a window from a script, with and without window features.
        const opened = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('open')) })
        check(
          'window.open from a click reaches the app once: the address, "foreground-tab", no name, the asking page as referrer, a GET',
          same(popupOf(opened), { url: `${SITE_ORIGIN}/from-script?x=1`, disposition: 'foreground-tab', frameName: '', referrer: `${SITE_ORIGIN}/`, method: 'GET' }),
          JSON.stringify(opened)
        )
        check(
          'the event bubbles to a listener on document, is composed, is fired on the element that shows the page, and its detail is an ordinary object the page can read',
          opened[0]?.bubbles === true && opened[0].composed && opened[0].element === 1 && opened[0].plainObject,
          JSON.stringify(opened)
        )
        const sized = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('features')) })
        check('window.open with features is "new-window" and carries the name it was given', popupOf(sized)?.disposition === 'new-window' && popupOf(sized)?.frameName === 'sized', JSON.stringify(sized))

        // ---- links and a form.
        const blank = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('blank')) })
        check('a target=_blank link click is "foreground-tab", once', popupOf(blank)?.disposition === 'foreground-tab' && popupOf(blank)?.url === `${SITE_ORIGIN}/popup-target`, JSON.stringify(blank))
        const ctrl = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('plain'), ['control']) })
        check('a control-click on a plain link is "background-tab", once', popupOf(ctrl)?.disposition === 'background-tab' && popupOf(ctrl)?.url === `${SITE_ORIGIN}/plain-target`, JSON.stringify(ctrl))
        const named = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('named')) })
        check('a link with a target name carries the name', popupOf(named)?.frameName === 'pane' && popupOf(named)?.url === `${SITE_ORIGIN}/named-target`, JSON.stringify(named))
        const posted = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('post')) })
        check('a form posted with a target reaches the app as its address alone, marked POST', popupOf(posted)?.method === 'POST' && popupOf(posted)?.url === `${SITE_ORIGIN}/posted`, JSON.stringify(posted))

        // ---- downloads.
        const expectedDownload = { url: `${SITE_ORIGIN}/${FILE_NAME}`, filename: FILE_NAME, mimeType: 'application/x-orivon-test', totalBytes: FILE_BODY.length }
        const attachment = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('download')) })
        check('an attachment reaches the app once: its address, bare file name, content type and size', same(downloadOf(attachment), expectedDownload), JSON.stringify(attachment))
        const redirected = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('redirect')) })
        check('a download after a redirect names the address it came from in the end', same(downloadOf(redirected), expectedDownload), JSON.stringify(redirected))
        const blob = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('blob')) })
        const blobDetail = downloadOf(blob)
        check(
          'a download from a blob: address reaches the app with the blob address, the name the page gave and its type',
          blobDetail?.url.startsWith(`blob:${SITE_ORIGIN}/`) === true && blobDetail.filename === BLOB_NAME && blobDetail.mimeType === 'text/plain' && blobDetail.totalBytes === 'made by the page'.length,
          JSON.stringify(blob)
        )
        const foreign = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('foreign')) }, 0)
        check('a link to an attachment on an origin the grant does not name fires nothing', foreign.length === 0, JSON.stringify(foreign))
        const counter = await app.evaluate(() => (globalThis as unknown as { __embedCounter: { downloads: number } }).__embedCounter)
        check('only the three admitted downloads ever reached the session\'s will-download, the refused one never did', counter.downloads === 3, JSON.stringify(counter))

        // ---- the address cap: Chromium itself refuses an address past LIMITS.embedEventUrlBytes.
        const atLimit = await heardAfter(view, async () => {
          await evaluateRetrying(view, async () => { await (window as unknown as PageState).__embedView.executeJavaScript((window as unknown as PageState).__embedLong[0] as string) })
        })
        check('an address exactly at the limit arrives whole', popupOf(atLimit)?.url.length === LIMITS.embedEventUrlBytes, String(popupOf(atLimit)?.url.length))
        const pastLimit = await heardAfter(view, async () => {
          await evaluateRetrying(view, async () => { await (window as unknown as PageState).__embedView.executeJavaScript((window as unknown as PageState).__embedLong[1] as string) })
        })
        check(
          'an address one byte past it never reaches the app as that address: Chromium hands the shell about:blank, which arrives as it is',
          popupOf(pastLimit)?.url === 'about:blank#blocked',
          JSON.stringify(popupOf(pastLimit)?.url.slice(0, 40))
        )

        // ---- each event is fired on its own element.
        const fromSecond = await heardAfter(view, async () => { await clickGuest(app, secondGuestId, rowMiddle('blank')) })
        const ownHeard = await evaluateRetrying(view, () => (window as unknown as PageState).__embedOwn.slice())
        check('a page shown in the second element fires on the second element, and on no other', fromSecond[0]?.element === 2 && ownHeard.length === 1, JSON.stringify({ fromSecond, ownHeard }))
        const fromFirst = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('blank')) })
        const ownAfter = await evaluateRetrying(view, () => (window as unknown as PageState).__embedOwn.slice())
        check('a page shown in the first element does not fire on the second', fromFirst[0]?.element === 1 && ownAfter.length === 1, JSON.stringify({ fromFirst, ownAfter }))

        // ---- nothing opened, nothing kept.
        const surfaceAfter = await surface()
        check('no window, view or tab was opened by any of it', same(surfaceBefore, surfaceAfter), JSON.stringify({ surfaceBefore, surfaceAfter }))
        check('no file was written for any download', keptFiles().length === 0, JSON.stringify({ downloadsDir, files: keptFiles() }))

        // ---- an element inside a shadow root is found too, once the shallow search has no match.
        const shadowGuest = await evaluateRetrying(view, async () => {
          const page = window as unknown as PageState & { __embedShadowHeard: string[] }
          page.__embedShadowHeard = []
          const host = document.createElement('div')
          const root = host.attachShadow({ mode: 'open' })
          const el = document.createElement('webview') as HTMLElement & Element2 & { src: string }
          el.src = `${location.protocol}//${location.hostname}:8961/`
          el.style.width = '640px'
          el.style.height = '520px'
          root.addEventListener('orivon-popup', () => { page.__embedShadowHeard.push('shadow root heard it') })
          const loaded = new Promise<string>((resolve) => {
            el.addEventListener('did-finish-load', () => { resolve('finished') })
            setTimeout(() => { resolve('timeout') }, 15_000)
          })
          root.append(el)
          document.body.append(host)
          return { outcome: await loaded, guestId: el.getWebContentsId() }
        }, STEP_TIMEOUT_MS)
        check('a <webview> inside a shadow root loads', shadowGuest.outcome === 'finished', JSON.stringify(shadowGuest))
        const fromShadow = await heardAfter(view, async () => { await clickGuest(app, shadowGuest.guestId, rowMiddle('blank')) })
        const shadowHeard = await evaluateRetrying(view, () => (window as unknown as { __embedShadowHeard: string[] }).__embedShadowHeard.slice())
        check(
          'a notice for a page shown inside a shadow root is fired on that element: its root and the document both hear it once',
          fromShadow.length === 1 && fromShadow[0]?.name === 'orivon-popup' && shadowHeard.length === 1,
          JSON.stringify({ fromShadow, shadowHeard })
        )

        // ---- A306: a scheme Chromium does not know.
        await stubNativeDialogs(app)
        check('no question is on screen to begin with', await questionGone(app))
        await evaluateRetrying(view, () => { (window as unknown as PageState).__embedNavigations.length = 0 })
        const custom = await heardAfter(view, async () => { await clickGuest(app, guestId, rowMiddle('custom')) }, 0)
        await evaluateRetrying(view, async () => { await (window as unknown as PageState).__embedView.executeJavaScript('location.href = "foo://x/y"') })
        await delay(ABSENCE_SETTLE_MS)
        const navigations = await evaluateRetrying(view, () => (window as unknown as PageState).__embedNavigations.slice())
        const asked = [...await noNativeDialogs(app), ...(await questionGone(app) ? [] : ['question panel'])]
        check('the element hears will-navigate with the address, for a click and for a script alike', navigations.length === 2 && navigations.every((url: string) => url === 'foo://x/y'), JSON.stringify(navigations))
        check('the shell raised no external-link question for it, in the panel or natively', asked.length === 0, JSON.stringify(asked))
        check('it is neither a popup nor a download', custom.length === 0, JSON.stringify(custom))
        const stayed = await evaluateRetrying(view, async () => (window as unknown as PageState).__embedView.executeJavaScript('location.href'))
        check('the shown page stays where it was', stayed === `${SITE_ORIGIN}/`, String(stayed))

        // ---- a dialog of the shown page is asked in the app's own tab, with the shown page's origin, and never in a native box.
        // The debugger reports every dialog a page raises, and Playwright dismisses one nobody listens for: the shown page's would be answered no before the person could answer it.
        for (const page of app.context().pages()) page.on('dialog', () => {})
        await clickGuest(app, guestId, rowMiddle('ask'))
        const panel = await waitQuestion(app)
        const spoken = await readQuestion(panel)
        check('the shown page\'s confirm is asked in the app tab\'s panel, headed with the shown page\'s origin', spoken.origin === `${SITE_ORIGIN} says` && spoken.message === 'the shown page asks', JSON.stringify(spoken))
        await answerQuestion(app, 'OK')
        const answer = await waitFor(async () => await evaluateRetrying(view, async () => (window as unknown as PageState).__embedView.executeJavaScript('window.asked')) === true, EVENT_WAIT_MS)
        check('the shown page reads the answer', answer)
        check('no native box was drawn for it', (await noNativeDialogs(app)).length === 0)
      } finally {
        await closeElectronApp(app)
      }
    })
  },
  TEST_TIMEOUT_MS
)
