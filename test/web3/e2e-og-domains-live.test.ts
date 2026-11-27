// `.og` names on mainnet, live and opt-in (ORIVON_OG_LIVE=1; CI never sets it): the real light client, the default Ethereum
// servers and the real IPFS network, no fixtures. One cold launch opens each name in a tab and records what the tab shows and
// how long it took: names with a record open from IPFS under `ipfs://<name>`, a name whose record is a contract is said to be
// unsupported, a name nobody holds or that holds nothing is "Nothing here", and a name that is not one label under `.og` is
// refused before anything is looked up. The light client's sync is timed on its own, before the first name is asked, so each
// name's seconds run from the moment the client followed the chain. A content name opened twice in one run must be faster
// the second time: the log windows read for it are kept. Needs the e2e build first and the network.
//
//   ORIVON_OG_LIVE=1 node scripts/build-e2e.mjs && ORIVON_OG_LIVE=1 node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/web3/e2e-og-domains-live.test.ts
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { renderErrorPage } from '../../src/protocols/verifier-host/serve/error-pages.js'
import type { ErrorPage } from '../../src/protocols/verifier-host/serve/error-pages.js'
import { assertNoElectronSurvivors, launchElectron, mainOutput } from '../support/launch-electron.mjs'
import { activeTabInfo, findChrome, waitFor } from '../support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, waitForAddressBarStable } from '../support/e2e-helpers.js'

const LIVE = process.env['ORIVON_OG_LIVE'] === '1'

/** Names whose records are text records of the wrapper (the first two) and the registry's own `content` slot (the last). */
const CONTENT_NAMES = ['aiagent.og', 'jsunblaze.og', 'visioned.og']
/** A name whose record is a contract, which Orivon cannot load. */
const CONTRACT_NAME = 'chaosroadsmint.og'
/** Names held by someone, with nothing to open; and one nobody registered. */
const EMPTY_NAMES = ['ecdn.og', 'orivon.og']
const UNREGISTERED = `${Array.from(randomBytes(20), (byte) => String.fromCharCode(97 + (byte % 26))).join('')}.og`
/** Not one label under `.og`: a label before the name, and a punycode label. */
const REFUSED_NAMES = ['a.b.og', 'xn--nxasmq6b.og']

/** The most a content name may take from the moment the light client follows the chain. */
const CONTENT_WITHIN_MS = 30_000
/** The longest a visit is watched for any outcome, so a stuck one is reported and not waited on. */
const WATCH_MS = 90_000
/** How much longer a page that finished loading is given to show some text. */
const DRAW_WITHIN_MS = 15_000
const SYNC_WITHIN_MS = 240_000
const POLL_MS = 100
const TEST_TIMEOUT_MS = WATCH_MS + 60_000

type Outcome = ErrorPage | 'content'

/** The tab titles the verifier's error pages carry, by the failure each says. */
const FAILURE_TITLES = new Map<string, ErrorPage>((['not-synced', 'unverifiable', 'unavailable', 'not-found', 'invalid-name', 'unsupported'] as const).map((failure) => {
  const title = /<title>(.*?)<\/title>/.exec(renderErrorPage(failure, '', '').html)?.[1] ?? ''
  return [title, failure]
}))

interface Visit {
  readonly name: string
  readonly outcome: Outcome | 'none'
  /** From the Enter that opened the name to the outcome. */
  readonly ms: number
  /** What the address bar showed once the outcome was reached. */
  readonly address: string
  readonly title: string
  /** The words of the page: the error page's lead and detail, or the length and start of a page's own text. */
  readonly text: string
  /** The lines the verifier and the light client wrote while the name was open that name a server, a refusal or a limit. */
  readonly log: string[]
}

interface TabView { readonly url: string, readonly title: string, readonly loading: boolean }

describe.skipIf(!LIVE)('.og names on mainnet, live', () => {
  let app: ElectronApplication | undefined
  let chrome: Page
  const visits = new Map<string, Visit>()

  /** The tab's own web contents for `host`, read in the main process (it needs no page attached on any system). */
  async function tabAt (host: string): Promise<TabView | undefined> {
    return await (app as ElectronApplication).evaluate(({ webContents }, wanted) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue
        let hostname = ''
        try { hostname = new URL(contents.getURL()).hostname } catch { continue }
        if (hostname === wanted) return { url: contents.getURL(), title: contents.getTitle(), loading: contents.isLoading() }
      }
      return undefined
    }, host)
  }

  async function pageText (host: string): Promise<string> {
    return await (app as ElectronApplication).evaluate(async ({ webContents }, wanted) => {
      for (const contents of webContents.getAllWebContents()) {
        if (contents.isDestroyed()) continue
        let hostname = ''
        try { hostname = new URL(contents.getURL()).hostname } catch { continue }
        if (hostname !== wanted) continue
        const text = await contents.executeJavaScript('document.body === null ? "" : document.body.innerText') as string
        return text
      }
      return ''
    }, host)
  }

  /** A blank tab, so a name opened twice is never read from the page it left behind. */
  async function blank (host: string): Promise<void> {
    await clickAddressBarRetrying(chrome, 'about:blank')
    await waitFor(async () => (await tabAt(host)) === undefined, 10_000)
  }

  async function visit (key: string, input: string, host: string, repeated = false): Promise<Visit> {
    if (repeated) await blank(host)
    const logFrom = mainOutput(app as ElectronApplication).length
    const started = Date.now()
    await clickAddressBarRetrying(chrome, input)
    let outcome: Outcome | 'none' = 'none'
    let view: TabView | undefined
    let address = ''
    for (;;) {
      view = await tabAt(host)
      if (view !== undefined) {
        const failure = FAILURE_TITLES.get(view.title)
        if (failure !== undefined) { outcome = failure; break }
        const info = await activeTabInfo(chrome)
        address = info.address ?? ''
        if (!view.loading && view.title !== '' && view.title !== 'Loading' && address.startsWith(`ipfs://${host}`)) { outcome = 'content'; break }
      }
      if (Date.now() - started > WATCH_MS) break
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
    }
    const ms = Date.now() - started
    address = (await activeTabInfo(chrome)).address ?? address
    let body = (await pageText(host).catch(() => '')).replace(/\s+/g, ' ').trim()
    // A page that draws itself with a script has no text at the moment it finishes loading: it is given a little longer to show some.
    let drawnMs = ms
    while (outcome === 'content' && body === '' && Date.now() - started < ms + DRAW_WITHIN_MS) {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS))
      body = (await pageText(host).catch(() => '')).replace(/\s+/g, ' ').trim()
      drawnMs = Date.now() - started
    }
    const text = outcome === 'content' ? `${String(body.length)} characters after ${String(drawnMs)} ms: ${body.slice(0, 160)}` : body.slice(0, 600)
    const log = mainOutput(app as ElectronApplication).slice(logFrom).split('\n').filter((line) => /execution server|refus|\b(403|429)\b|rate|limit|unavailable|failed/i.test(line)).slice(0, 20)
    const result: Visit = { name: input, outcome, ms, address, title: view?.title ?? '', text, log }
    visits.set(key, result)
    console.log(`[og live] ${JSON.stringify(result)}`)
    return result
  }

  beforeAll(async () => {
    app = await launchElectron({ appPath: '.', env: { ORIVON_ETH_LIGHT_CLIENT: 'on' } })
    const running = app
    expect(await waitFor(() => running.windows().length === 2)).toBe(true)
    chrome = findChrome(running)
    await waitForAddressBarStable(chrome)
  }, 120_000)

  afterAll(async () => {
    if (app !== undefined) {
      console.log(`[og live] light client and verifier lines:\n${mainOutput(app).split('\n').filter((line) => /\[verifier\]|light client|\[ipfs-node\]/.test(line)).slice(-60).join('\n')}`)
      await closeElectronApp(app, APP_CLOSE_RACE_MS)
    }
    expect(await assertNoElectronSurvivors()).toEqual([])
  })

  it('starts the light client when a .og name is typed, and follows the chain', async () => {
    const running = app as ElectronApplication
    const typedAt = Date.now()
    await chrome.click('#address')
    await chrome.fill('#address', CONTENT_NAMES[0] as string)
    const synced = await waitFor(() => /light client synced at block \d+/.test(mainOutput(running)), SYNC_WITHIN_MS)
    const syncMs = Date.now() - typedAt
    const block = /light client synced at block (\d+)/.exec(mainOutput(running))?.[1]
    console.log(`[og live] light client synced=${String(synced)} after ${String(syncMs)} ms at block ${String(block)}`)
    expect(synced, 'the light client followed the chain').toBe(true)
  }, SYNC_WITHIN_MS + 30_000)

  it.each(CONTENT_NAMES.map((name) => [name]))('opens %s from IPFS under its own name, within 30 s of the light client following the chain', async (name) => {
    const result = await visit(name, name, name)
    expect(result.outcome, JSON.stringify(result)).toBe('content')
    expect(result.address).toBe(`ipfs://${name}/`)
    expect(result.text, 'the page drew some text').not.toMatch(/^0 characters/)
    expect(result.ms, JSON.stringify(result)).toBeLessThanOrEqual(CONTENT_WITHIN_MS)
  }, TEST_TIMEOUT_MS)

  it('says a contract record is not supported, never a blank page', async () => {
    const result = await visit(CONTRACT_NAME, CONTRACT_NAME, CONTRACT_NAME)
    expect(result.outcome, JSON.stringify(result)).toBe('unsupported')
    expect(result.text.length).toBeGreaterThan(0)
  }, TEST_TIMEOUT_MS)

  it.each([...EMPTY_NAMES, UNREGISTERED].map((name) => [name]))('shows no website for %s', async (name) => {
    const result = await visit(name, name, name)
    expect(result.outcome, JSON.stringify(result)).toBe('not-found')
  }, TEST_TIMEOUT_MS)

  it.each(REFUSED_NAMES.map((name) => [name]))('refuses %s as a name it cannot look up', async (name) => {
    const result = await visit(name, name, name)
    expect(result.outcome, JSON.stringify(result)).toBe('invalid-name')
  }, TEST_TIMEOUT_MS)

  it('opens a name a second time faster, because the log windows read for it are kept', async () => {
    const name = CONTENT_NAMES[0] as string
    const first = visits.get(name)
    expect(first, 'the first load of the name ran').toBeDefined()
    const again = await visit(`${name} again`, name, name, true)
    // A path nothing has fetched: the page itself is not what is saved, the name's history is.
    const fresh = await visit(`${name} again, new path`, `${name}/?second-load`, name, true)
    console.log(`[og live] ${name}: first ${String(first?.ms)} ms, retyped ${String(again.ms)} ms, retyped with a new path ${String(fresh.ms)} ms`)
    expect(again.outcome).toBe('content')
    expect(fresh.outcome).toBe('content')
    expect(fresh.ms).toBeLessThan(first?.ms ?? 0)
  }, TEST_TIMEOUT_MS * 2)
})
