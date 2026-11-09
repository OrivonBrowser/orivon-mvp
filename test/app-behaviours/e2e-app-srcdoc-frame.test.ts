// What a same-origin `srcdoc` frame an app creates can run under the app's own script policy (`script-src 'self'
// 'unsafe-eval' 'wasm-unsafe-eval'`, no `'unsafe-inline'`): its inline script and inline event handler are refused, a
// `<script src>` of a file the app serves runs, and that script evaluates strings whose code reaches the parent page and
// calls an `orivon.*` member the app holds. One launch. The check carries the id of the behaviour it protects
// (test/app-behaviours/catalogue.md).
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-srcdoc-frame.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { appManifest, grantApp, pageCall, startAppServer } from './app-behaviour-support.js'
import type { AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

const HTML = 'text/html; charset=utf-8'
const JS = 'text/javascript'
const FOLDER_BY_EVAL = 'made-by-eval-in-the-frame'
const FOLDER_BY_FUNCTION = 'made-by-new-function-in-the-frame'

// A registered app's own policy admits no inline script: the app's page is a file, and so is every script it runs.
const PAGE = '<!doctype html><html><head><title>srcdoc frame</title></head><body><script src="/app.js"></script></body></html>'

// The app opens one frame the way a host page opens a plugin: a `sandbox` that keeps the app's origin, and a document
// built as a string. What it holds, in order: a watcher that reports every policy violation, an inline script, an inline
// event handler, and a script file the app serves.
const APP_JS = `
window.__frameMessages = []
window.addEventListener('message', (event) => { window.__frameMessages.push(event.data) })
const document_ = [
  '<!doctype html><html><head><meta charset="utf-8"></head><body>',
  '<script src="/frame-watch.js"></script>',
  '<script>parent.postMessage({ step: "inline-script-ran" }, "*")</script>',
  '<button id="b" onclick="parent.postMessage({ step: &quot;inline-handler-ran&quot; }, &quot;*&quot;)">b</button>',
  '<script src="/frame-run.js"></script>',
  '</body></html>'
].join('\\n')
const frame = document.createElement('iframe')
frame.setAttribute('sandbox', 'allow-scripts allow-same-origin')
frame.srcdoc = document_
document.body.append(frame)
`

const FRAME_WATCH_JS = `
document.addEventListener('securitypolicyviolation', (event) => {
  parent.postMessage({ step: 'violation', directive: event.effectiveDirective, blocked: event.blockedURI, policy: event.originalPolicy }, '*')
})
`

// Every attempt reports what it did, so a refusal reads as a value and not as a missing message. `attempt` runs its
// callback before its first await, so the page's own script is on the stack of each string evaluated here.
const FRAME_RUN_JS = `
(async () => {
const attempt = async (run) => {
  try { return await run() } catch (error) { return 'threw ' + String(error && error.name) + ': ' + String(error && error.message) }
}
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
parent.postMessage({ step: 'served-script-ran' }, '*')
const outcome = { step: 'done', origin: self.origin, documentUrl: document.URL }
document.getElementById('b').click()
outcome.indirectEval = await attempt(() => (0, eval)('6 * 7'))
outcome.newFunction = await attempt(() => new Function('a', 'b', 'return a + b')(20, 22))
outcome.asyncFunction = await attempt(() => new AsyncFunction('return await Promise.resolve(7)')())
outcome.evalReachesParent = await attempt(() => (0, eval)("parent.document.body.setAttribute('data-reached-by-frame', parent.document.title); parent.location.origin"))
outcome.evalCallsOrivon = await attempt(() => (0, eval)("parent.orivon.fs.mkdir('${FOLDER_BY_EVAL}')").then(() => 'ok'))
outcome.functionCallsOrivon = await attempt(() => new Function("return parent.orivon.fs.mkdir('${FOLDER_BY_FUNCTION}')")().then(() => 'ok'))
parent.postMessage(outcome, '*')
})()
`

interface Message {
  readonly step: string
  readonly directive?: string
  readonly blocked?: string
  readonly policy?: string
  readonly origin?: string
  readonly documentUrl?: string
  readonly indirectEval?: unknown
  readonly newFunction?: unknown
  readonly asyncFunction?: unknown
  readonly evalReachesParent?: unknown
  readonly evalCallsOrivon?: unknown
  readonly functionCallsOrivon?: unknown
}

let server: AppServer
let app: ElectronApplication
let chrome: Page
let view: Page

beforeAll(async () => {
  server = await startAppServer({
    '/': { type: HTML, body: PAGE },
    '/app.js': { type: JS, body: APP_JS },
    '/frame-watch.js': { type: JS, body: FRAME_WATCH_JS },
    '/frame-run.js': { type: JS, body: FRAME_RUN_JS }
  })
  const launched = await launchShell()
  app = launched.app
  chrome = launched.chrome
  await grantApp(app, server.origin, appManifest('srcdoc-frame', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
  view = await visit(app, chrome, `${server.origin}/`)
}, 180_000)

afterAll(async () => {
  if (app !== undefined) await closeElectron(app)
  await server?.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:srcdoc-frame-runs-served-script] a srcdoc frame of an app refuses its inline script and handler, runs a script the app serves, and that script evaluates strings that reach the parent and call a granted member', async () => {
  await runPhase('srcdoc frame under the app policy', async (check) => {
    // The served script posts `done` after everything it does, and the inline script and handler come before it in the
    // document, so their chance to run has passed. A policy refusal is reported by a task of its own: wait for each
    // one (or for the code it refused having run), never for the clock.
    await view.waitForFunction(() => {
      const messages = (window as unknown as { __frameMessages: Array<{ step: string, directive?: string }> }).__frameMessages
      const seen = (step: string): boolean => messages.some((message) => message.step === step)
      const refused = (directive: string): boolean => messages.some((message) => message.step === 'violation' && message.directive === directive)
      return seen('done') && (refused('script-src-elem') || seen('inline-script-ran')) && (refused('script-src-attr') || seen('inline-handler-ran'))
    }, undefined, { timeout: 30_000 })
    const messages = await view.evaluate(() => (window as unknown as { __frameMessages: Message[] }).__frameMessages)
    const detail = JSON.stringify(messages)
    const done = messages.find((message) => message.step === 'done')
    const violations = messages.filter((message) => message.step === 'violation')

    check('[app:srcdoc-frame-runs-served-script] the frame is an about:srcdoc document with the app\'s origin', done?.documentUrl === 'about:srcdoc' && done.origin === server.origin, detail)

    check('[app:srcdoc-frame-runs-served-script] the frame\'s inline script did not run', !messages.some((message) => message.step === 'inline-script-ran'), detail)
    const inlineRefusal = violations.find((violation) => violation.blocked === 'inline' && violation.directive === 'script-src-elem')
    const scriptPolicy = /(?:^|; )script-src ([^;]*)/.exec(inlineRefusal?.policy ?? '')?.[1] ?? ''
    check(
      '[app:srcdoc-frame-runs-served-script] the inline script was refused by the policy the app\'s own document carries: script-src admits \'self\' and string evaluation, no \'unsafe-inline\'',
      inlineRefusal !== undefined && scriptPolicy.includes("'self'") && scriptPolicy.includes("'unsafe-eval'") && !scriptPolicy.includes("'unsafe-inline'"),
      detail
    )
    check('[app:srcdoc-frame-runs-served-script] the frame\'s inline event handler did not run, and the policy refused it', !messages.some((message) => message.step === 'inline-handler-ran') && violations.some((violation) => violation.blocked === 'inline' && violation.directive === 'script-src-attr'), detail)

    check('[app:srcdoc-frame-runs-served-script] a script the app serves runs in the frame', messages.some((message) => message.step === 'served-script-ran'), detail)
    check('[app:srcdoc-frame-runs-served-script] indirect eval, new Function and an async function built from a string run in the frame',
      done?.indirectEval === 42 && done.newFunction === 42 && done.asyncFunction === 7, detail)
    check('[app:srcdoc-frame-runs-served-script] evaluated code in the frame reads and writes the parent page', done?.evalReachesParent === server.origin, detail)
    const reached = await view.evaluate(() => document.body.getAttribute('data-reached-by-frame'))
    check('[app:srcdoc-frame-runs-served-script] the parent page shows what the frame wrote into it', reached === 'srcdoc frame', String(reached))

    check('[app:srcdoc-frame-runs-served-script] evaluated code in the frame calls an orivon member the app holds (eval and new Function, through parent.orivon), as the app',
      done?.evalCallsOrivon === 'ok' && done.functionCallsOrivon === 'ok', detail)
    const made = await pageCall(server, view, async (names: readonly string[]) => {
      const orivon = (window as unknown as { orivon: { fs: { stat: (path: string) => Promise<{ isDirectory: boolean }> } } }).orivon
      return await Promise.all(names.map(async (name) => (await orivon.fs.stat(name)).isDirectory))
    }, [FOLDER_BY_EVAL, FOLDER_BY_FUNCTION]).catch((error: unknown) => [`stat failed: ${String(error)}`])
    check('[app:srcdoc-frame-runs-served-script] the app\'s own page finds the two folders those calls made', made.length === 2 && made.every((isDirectory) => isDirectory === true), JSON.stringify(made))
  })
}, QA_TEST_TIMEOUT_MS)
