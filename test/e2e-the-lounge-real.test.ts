// The Lounge, upstream's own Node server, running as an Orivon app: the launcher forks the bundled
// server into a Worker through the Node shim, the server listens on 127.0.0.1:9000, and the page it
// serves shows in a <webview> under web.embed's local pattern. Real consent prompt, real broker, real
// sockets; the IRC servers are ours (irc-fake-server.mjs, one plain and one TLS with a self-signed
// certificate), and the only network anything touches is loopback.
//
// THE APP LIVES IN THE SIBLING REPOSITORY (`orivon-ports`), which owns the build. Skipped when that
// checkout or its prepared build is absent, and on the e2e build (this file needs the ordinary one).
// Fixed ports, because the manifest fixes them: 9000 (the server's listener), and 6667 and 6697 (the
// loopback IRC addresses it may dial).
//
// RUN THIS WITH:
//   cd ../orivon-ports && ORIVON_MVP_ROOT=<this checkout> node src/cli.ts build the-lounge --rebuild
//   node scripts/build-ordinary.mjs
//   ORIVON_ORDINARY_BUILD=1 npx vitest run --config test/vitest.e2e.config.ts test/e2e-the-lounge-real.test.ts
import { afterAll, expect, it } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { assertNoElectronSurvivors, closeElectron, launchElectron, profileDirOf } from './support/launch-electron.mjs'
import { HERMETIC_RESOLVER, findChrome, tabIds, waitFor } from './support/smoke-helpers.mjs'
import { APP_CLOSE_RACE_MS, clickAddressBarRetrying, closeElectronApp, killChild, runPhase, waitForAddressBarStable } from './support/e2e-helpers.js'
import { startOwnServer } from './support/freetube-fixture.js'
import { startFakeIrc } from './irc-fake-server.mjs'
import { generateSelfSignedFixture } from '../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import {
  ACCOUNT, BUILT, CHANNEL, IRC_PORT, IRC_TLS_PORT, LOUNGE_URL, NICK, ORIGIN, PORTS_ROOT, SERVE_PORT, STATIC_ROOT,
  answerConsent, collectPageLogs, typeInto, filesEnding, launcherView, launcherViews, logOf, loungePage, promptsSeen, statusOf, within
} from './the-lounge-support.js'
import type { Launched } from './the-lounge-support.js'

const ORDINARY_BUILD = process.env['ORIVON_ORDINARY_BUILD'] === '1'
const TEST_TIMEOUT_MS = 300_000
const START_MS = 90_000
const LINK = `${ORIGIN}/LICENSE`

afterAll(async () => {
  if (!ORDINARY_BUILD || !BUILT) return
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type Page = ReturnType<typeof findChrome>

/** Launches the shell, answers the consent prompt "allow" and opens the app's address. */
async function openApp (reuseProfile?: string): Promise<{ app: Launched, chrome: Page, logs: string[] }> {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER], ...(reuseProfile === undefined ? {} : { reuseProfile }) })
  await answerConsent(app)
  const logs = collectPageLogs(app)
  await waitFor(() => app.windows().length === 2)
  const chrome = findChrome(app)
  await waitForAddressBarStable(chrome)
  await clickAddressBarRetrying(chrome, `${ORIGIN}/`)
  return { app, chrome, logs }
}

/**
 * The launcher tab's Playwright page, once it has answered. Granting the app replaces its tab's view, so a
 * page kept from before the grant is a closed one: look it up again each time it is needed.
 */
async function launcherOf (app: Launched, chrome: Page): Promise<Page> {
  const found = await waitFor(async () => {
    const view = launcherView(app, chrome)
    return view !== undefined && (await statusOf(view)) !== ''
  }, 30_000)
  const view = launcherView(app, chrome)
  if (!found || view === undefined) throw new Error('no view shows the app')
  return view
}

async function waitStatus (app: Launched, chrome: Page, pattern: RegExp, ms = START_MS): Promise<string> {
  let last = ''
  await waitFor(async () => { const view = launcherView(app, chrome); last = view === undefined ? '' : await statusOf(view); return pattern.test(last) }, ms)
  return last
}

async function waitLoungeFor (app: Launched, ms: number): Promise<Page | undefined> {
  await waitFor(() => loungePage(app) !== undefined, ms)
  return loungePage(app)
}

async function signIn (lounge: Page): Promise<void> {
  await lounge.waitForSelector('#sign-in', { timeout: 30_000 })
  await typeInto(lounge, '#signin-username', ACCOUNT.name)
  await typeInto(lounge, '#signin-password', ACCOUNT.password)
  await lounge.click('#sign-in button[type=submit]')
}

const chatText = async (lounge: Page): Promise<string> => await within(lounge.evaluate(() => document.querySelector('#chat')?.textContent ?? ''), 5_000, '')
const chatHas = async (lounge: Page, text: string, ms: number): Promise<boolean> => await waitFor(async () => (await chatText(lounge)).includes(text), ms)

const noise = (line: string): boolean => !line.includes('Electron Security Warning')

it.skipIf(!ORDINARY_BUILD || !BUILT)(
  'upstream The Lounge runs in a forked Worker of an Orivon app and chats with an IRC server',
  async () => {
    await runPhase('the-lounge-real', async (check) => {
      let app: Launched | undefined
      let server: ChildProcess | undefined
      let irc: Awaited<ReturnType<typeof startFakeIrc>> | undefined
      let ircTls: Awaited<ReturnType<typeof startFakeIrc>> | undefined
      const t0 = Date.now()
      const since = (): string => `${String(Math.round((Date.now() - t0) / 100) / 10)}s`
      const mark = (name: string): void => { console.log(`[lounge-e2e] ${since()} ${name}`) }
      let logs: string[] = []
      try {
        irc = await startFakeIrc(IRC_PORT)
        ircTls = await startFakeIrc(IRC_TLS_PORT, '127.0.0.1', { tls: generateSelfSignedFixture() })
        server = await startOwnServer('the-lounge-serve', join(PORTS_ROOT, 'src', 'cli.ts'), ['serve', 'the-lounge', '--port', String(SERVE_PORT)])
        check(`a plain static server serves the prepared build (${STATIC_ROOT})`, true)

        // ---- first launch: consent, account, server, sign-in, connect, chat -----------------------------
        const first = await openApp()
        app = first.app
        logs = first.logs
        const chrome = first.chrome
        mark('opened')

        const prompted = await waitFor(async () => (await promptsSeen(first.app)).length > 0, 30_000)
        const prompt = JSON.stringify((await promptsSeen(first.app))[0] ?? {})
        check('a) the consent prompt lists the grants: the loopback listener, the embedded pages, the files, and the network', prompted &&
          prompt.includes('port 9000') && prompt.includes('Store files') && prompt.includes('Unlimited network access') && prompt.includes('pages it serves itself'), prompt)

        const formShown = await waitFor(async () => {
          const view = launcherView(first.app, chrome)
          return view !== undefined && await within(view.evaluate(() => document.querySelector('#setup')?.hasAttribute('hidden') === false), 5_000, false)
        }, 60_000)
        const launcher = await launcherOf(app, chrome)
        check(`b) the launcher prepared the install tree and asks for the first account (${since()})`, formShown, await statusOf(launcher))
        check('h) the launcher page is cross-origin isolated', await within(launcher.evaluate(() => crossOriginIsolated), 5_000, false))

        const started = Date.now()
        await launcher.fill('#account-name', ACCOUNT.name)
        await launcher.fill('#account-password', ACCOUNT.password)
        await launcher.fill('#account-confirm', ACCOUNT.password)
        await launcher.click('#setup-submit')
        const status = await waitStatus(app, chrome, /The server is running|stopped|Could not|not created/)
        check(`b) upstream's add made the account and the server printed "Available at" (${String(Date.now() - started)} ms from submit)`, status.startsWith('The server is running'),
          `${status} ## ${(await logOf(launcher)).slice(-2500)}`)
        mark('server running')

        const lounge = await waitLoungeFor(app, 30_000)
        check(`c) the <webview> loads ${LOUNGE_URL} and shows The Lounge's sign-in page`, lounge !== undefined && await waitFor(async () => await within(lounge.evaluate(() => document.querySelector('#sign-in') !== null), 3_000, false), 30_000),
          JSON.stringify(logs.filter(noise).slice(-20)))
        if (lounge === undefined) throw new Error('no Lounge page')
        await signIn(lounge)
        const connectShown = await lounge.waitForSelector('#connect', { timeout: 30_000 }).then(() => true, () => false)
        check('c) signing in as the account shows the connect form (upstream, private mode, no network yet)', connectShown, JSON.stringify(logs.filter(noise).slice(-10)))
        mark('signed in')

        // TLS first: toggling it moves the port to 6697.
        await lounge.uncheck('#connect input[name=tls]')
        await typeInto(lounge, '#connect input[name=name]', 'Orivon test')
        await typeInto(lounge, '#connect input[name=host]', '127.0.0.1')
        await typeInto(lounge, '#connect input[name=port]', String(IRC_PORT))
        await typeInto(lounge, '#connect input[name=nick]', NICK)
        await typeInto(lounge, '#connect input[name=join]', CHANNEL)
        await lounge.click('#connect button[type=submit]')
        const joined = await waitFor(() => irc !== undefined && irc.lines.some((line) => line === `JOIN ${CHANNEL}`), 30_000)
        const lines = irc.lines.join(' | ')
        check('d) the fake IRC server saw NICK, USER and JOIN from The Lounge, over plain TCP to 127.0.0.1:6667',
          joined && irc.lines.includes(`NICK ${NICK}`) && irc.lines.some((line) => line.startsWith('USER ')), lines)
        const shown = await waitFor(async () => (await within<string, string>(lounge.evaluate(() => document.querySelector('#sidebar')?.textContent ?? ''), 3_000, '')).includes(CHANNEL), 20_000)
        check('d) the channel is in the sidebar', shown)

        irc.say('bob', CHANNEL, 'hello from bob')
        check('e) a message the IRC server injects appears in the channel', await chatHas(lounge, 'hello from bob', 20_000), (await chatText(lounge)).slice(-400))
        await typeInto(lounge, '#input', 'hello from the account')
        await lounge.keyboard.press('Enter')
        const sent = await waitFor(() => irc !== undefined && irc.privmsgs().some((line) => line === `PRIVMSG ${CHANNEL} :hello from the account`), 15_000)
        check('e) a message typed in The Lounge reaches the IRC server', sent, irc.privmsgs().join(' | '))
        check('e) and shows in the channel as the account\'s own', await chatHas(lounge, 'hello from the account', 10_000))

        // j) TLS to a server whose certificate is self-signed, as some public networks' is. "Only allow trusted
        // certificates" (upstream's default) refuses it and the lobby says why in Node's words; unticked, it connects.
        const tlsFake = ircTls
        const connectTls = async (name: string, trustedOnly: boolean): Promise<void> => {
          await lounge.click('#footer button.connect')
          await lounge.waitForSelector('#connect', { timeout: 15_000 })
          await lounge.check('#connect input[name=tls]')
          await typeInto(lounge, '#connect input[name=name]', name)
          await typeInto(lounge, '#connect input[name=host]', 'localhost')
          await typeInto(lounge, '#connect input[name=port]', String(IRC_TLS_PORT))
          await typeInto(lounge, '#connect input[name=nick]', NICK)
          await typeInto(lounge, '#connect input[name=join]', '')
          await lounge.setChecked('#connect input[name=rejectUnauthorized]', trustedOnly)
          await lounge.click('#connect button[type=submit]')
        }
        await connectTls('Self-signed, trusted only', true)
        const refused = await chatHas(lounge, 'Error: self-signed certificate', 30_000)
        check('j) with trusted certificates only, the lobby shows Node\'s "self-signed certificate" and nothing was sent', refused && !tlsFake.lines.some((line) => line.startsWith('NICK ')),
          `${(await chatText(lounge)).slice(-400)} ## ${tlsFake.lines.join(' | ')}`)
        await connectTls('Self-signed, any certificate', false)
        const registered = await waitFor(() => tlsFake.lines.includes(`NICK ${NICK}`) && tlsFake.lines.some((line) => line.startsWith('USER ')), 30_000)
        check('j) with "Only allow trusted certificates" unticked, The Lounge registers over TLS', registered && await chatHas(lounge, 'Connected to the network.', 15_000),
          `${tlsFake.lines.join(' | ')} ## ${(await chatText(lounge)).slice(-400)}`)
        await lounge.click(`#sidebar .channel-list-item[data-name="${CHANNEL}"]`)

        // g) a link opens a tab of its own and leaves the shown page where it was.
        const tabsBefore = await tabIds(chrome)
        irc.say('bob', CHANNEL, `see ${LINK}`)
        await chatHas(lounge, 'see ', 10_000)
        const linkSelector = `#chat a[href="${LINK}"]`
        const linked = await lounge.waitForSelector(linkSelector, { timeout: 10_000 }).then(() => true, () => false)
        if (linked) await lounge.click(linkSelector)
        const opened = await waitFor(async () => (await tabIds(chrome)).length === tabsBefore.length + 1, 15_000)
        const stillThere = loungePage(app)?.url().startsWith(LOUNGE_URL) === true
        check('g) a link in a message opens a new tab (the orivon-popup path) and the shown page did not navigate', linked && opened && stillThere,
          JSON.stringify({ linked, opened, stillThere, tabs: (await tabIds(chrome)).length, url: loungePage(app)?.url() }))
        mark('first launch done')

        // f, part one: what the first run left on disk.
        const profile = profileDirOf(app)
        // Upstream saves the account file 5 s after a change (client.ts `save`, a debounce), by writing a
        // temp file and renaming it over the old one: wait for it, since the app closing first loses it.
        const userFile = async (): Promise<{ sessions: number, networks: string[] }> => {
          const file = profile === undefined ? undefined : filesEnding(profile, `${ACCOUNT.name}.json`)[0]
          if (file === undefined) return { sessions: 0, networks: [] }
          const user = JSON.parse(readFileSync(file.path, 'utf8')) as { sessions?: object, networks?: Array<{ name: string }> }
          return { sessions: Object.keys(user.sessions ?? {}).length, networks: (user.networks ?? []).map((network) => network.name) }
        }
        const saved = await waitFor(async () => (await userFile()).networks.length > 0, 25_000)
        check('f) upstream saved the account file with its network and session (write a temp file, rename over the old one)', saved && (await userFile()).sessions > 0, JSON.stringify(await userFile()))
        const sqlite = profile === undefined ? [] : filesEnding(profile, '.sqlite3')
        check(`f) the scrollback database is a file in the app's files (${sqlite.map((file) => `${file.path.slice(profile?.length ?? 0)} ${String(file.size)} B`).join(', ')})`,
          sqlite.some((file) => file.path.endsWith(`${ACCOUNT.name}.sqlite3`) && file.size > 4096))

        // ---- second launch on the same profile: no account form, scrollback, a second tab ----------------
        await closeElectron(app, { raceMs: APP_CLOSE_RACE_MS, keepProfile: true })
        app = undefined
        irc.lines.length = 0
        const second = await openApp(profile)
        app = second.app
        logs = second.logs
        const chrome2 = second.chrome
        const status2 = await waitStatus(app, chrome2, /The server is running|Waiting for you|stopped|Could not/)
        check('f) after a relaunch the launcher goes straight to the server: no account form', status2.startsWith('The server is running'), `${status2} ## ${(await logOf(await launcherOf(app, chrome2))).slice(-1500)}`)
        const lounge2 = await waitLoungeFor(app, 30_000)
        if (lounge2 === undefined) throw new Error('no Lounge page after the relaunch')
        const needsSignIn = await lounge2.waitForSelector('#sign-in', { timeout: 10_000 }).then(() => true, () => false)
        if (needsSignIn) await signIn(lounge2)
        // Upstream reopens on the network's own window; the channel is one click away.
        const channelItem = `#sidebar .channel-list-item[data-name="${CHANNEL}"]`
        await lounge2.waitForSelector(channelItem, { timeout: 30_000 }).then(async () => { await lounge2.click(channelItem) }, () => undefined)
        const restored = await chatHas(lounge2, 'hello from the account', 30_000)
        check('f) the earlier messages are there after the relaunch (scrollback read back from SQLite)', restored && await chatHas(lounge2, 'hello from bob', 5_000),
          (await chatText(lounge2)).slice(-600))

        // i) a second tab of the app finds the port held and shows the running server.
        await chrome2.click('#new-tab')
        await waitFor(async () => (await tabIds(chrome2)).length >= 3, 10_000)
        await waitForAddressBarStable(chrome2)
        await clickAddressBarRetrying(chrome2, `${ORIGIN}/`)
        const reused = await waitFor(async () => {
          for (const view of launcherViews(app as Launched, chrome2)) if (/another tab/.test(await statusOf(view))) return true
          return false
        }, START_MS)
        const statuses = await Promise.all(launcherViews(app, chrome2).map(async (view) => await statusOf(view)))
        check('i) a second tab of the app reuses the running server (EADDRINUSE): it says so, and shows no account form', reused, JSON.stringify(statuses))
        const setupVisible = await Promise.all(launcherViews(app, chrome2).map(async (view) => await within(view.evaluate(() => document.querySelector('#setup')?.hasAttribute('hidden') === false), 3_000, false)))
        check('i) and none of the app\'s tabs shows the account form', !setupVisible.some(Boolean), JSON.stringify(setupVisible))
        check('the fake IRC server was reached again by the restarted server', irc.lines.some((line) => line === `JOIN ${CHANNEL}`), irc.lines.join(' | '))
      } finally {
        if (app !== undefined) await closeElectronApp(app)
        if (server !== undefined) await killChild(server)
        if (irc !== undefined) await irc.close()
        if (ircTls !== undefined) await ircTls.close()
        if (logs.length > 0) console.log(`[lounge-e2e] last page logs: ${JSON.stringify(logs.filter(noise).slice(-25))}`)
      }
    })
  },
  TEST_TIMEOUT_MS
)
