// A page's own alert, confirm and prompt, and its beforeunload guard, in the running shell. Every one is asked in the
// question panel of the page's tab, headed with who is speaking (a frame inside the page by its own origin), and the
// page's script waits exactly as it would for a native box. The clicks are real: a page that holds the renderer is
// driven by a click that has not returned yet, so each click is started, answered through the panel, then awaited.
// Electron's native box is replaced by the shell's handler for Electron's own dialog event, so what proves it never
// opens is the stub on dialog.showMessageBox plus the page's own outcome: a script is released when its tab navigates
// away, and a call Chromium refuses (a sandbox without allow-modals, a page being left) never reaches the panel.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, expect, it } from 'vitest'
import type { ElectronApplication, Page } from 'playwright'
import { runCommand } from './auth-support.js'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from './question-support.js'
import { html, launchShell, startServer, visit } from './qa-helpers.js'
import type { FixtureServer } from './qa-helpers.js'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { ABSENCE_SETTLE_MS, delay, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'

const E2E_TIMEOUT_MS = 150_000
const servers: FixtureServer[] = []

afterAll(async () => {
  for (const server of servers) await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const NEXT = '<!doctype html><title>next page</title><body>next</body>'
const FRAME = `<!doctype html><title>frame</title><body>frame<script>
  onmessage = function () { var answer = confirm('the frame asks'); parent.postMessage('answered:' + answer, '*') }
</script></body>`

const CSP_SANDBOXED = `<!doctype html><title>Sandboxed top</title><body>top
<button id="ask" onclick="window.results = [prompt('csp prompt', 'x'), confirm('csp confirm')]">ask</button></body>`

const mainPage = (frameOrigin: string): string => `<!doctype html><title>Dialogs fixture</title><body style="font:16px sans-serif">
<button id="alert" onclick="alert('Hello there'); window.alerted = true">alert</button>
<button id="confirm" onclick="window.confirmed = confirm('Delete everything?')">confirm</button>
<button id="prompt" onclick="window.typed = prompt('Your name?', 'anon')">prompt</button>
<button id="loop" onclick="window.loop = [confirm('one'), confirm('two'), confirm('three'), confirm('four'), confirm('five')]">loop</button>
<button id="later" onclick="setTimeout(function () { window.later = confirm('later?') }, 300)">later</button>
<button id="blank" onclick="var f = document.createElement('iframe'); document.body.appendChild(f); window.blank = f.contentWindow.confirm('blank')">blank</button>
<button id="hold" onclick="window.held = confirm('hold on')">hold</button>
<button id="ask-frame" onclick="frames[0].postMessage('ask', '*')">ask frame</button>
<button id="guard" onclick="onbeforeunload = function (e) { e.preventDefault(); e.returnValue = 'x' }">guard</button>
<button id="go" onclick="location.href = '/next'">go</button>
<iframe src="${frameOrigin}/frame" title="frame"></iframe>
<iframe name="same" src="/frame"></iframe>
<iframe name="sandboxed" sandbox="allow-scripts" src="${frameOrigin}/frame"></iframe>
<button id="ask-sandboxed" onclick="window.frameAnswer = undefined; frames.sandboxed.postMessage('ask', '*')">ask sandboxed</button>
<button id="dismissal" onclick="onbeforeunload = function () { confirm('Call this number now') }; onpagehide = function () { alert('Your PC is infected'); prompt('Enter your password') }">dismissal dialogs</button>
<script>addEventListener('message', function (e) { if (typeof e.data === 'string' && e.data.indexOf('answered:') === 0) window.frameAnswer = e.data })</script>
</body>`

async function serve (): Promise<{ origin: string, frameOrigin: string }> {
  const frames = await startServer((_request, response) => { html(response, FRAME) })
  const main = await startServer((request, response) => {
    if (request.url === '/next') { html(response, NEXT); return }
    if (request.url === '/frame') { html(response, FRAME); return }
    if (request.url === '/csp-sandbox') {
      response.setHeader('content-security-policy', 'sandbox allow-scripts')
      html(response, CSP_SANDBOXED)
      return
    }
    html(response, mainPage(frames.origin))
  })
  servers.push(frames, main)
  return { origin: main.origin, frameOrigin: frames.origin }
}

/** Waits for the panel that says `message`, so a question just answered is not taken for the next one. */
async function waitQuestionSaying (app: ElectronApplication, message: string): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    try {
      const page = await waitQuestion(app, 5_000)
      if ((await readQuestion(page)).message !== message) return false
      found = page
      return true
    } catch {
      return false
    }
  }, 30_000)
  expect(ok).toBe(true)
  return found as Page
}

const read = async <T>(view: Page, name: string): Promise<T> => await view.evaluate((key) => (window as unknown as Record<string, unknown>)[key], name) as T

it('asks a page\'s alert, confirm and prompt in the panel, headed with the page\'s origin, and stops a loop on request', async () => {
  const { origin } = await serve()
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${origin}/`)
    view.on('dialog', () => {}) // The debugger reports every dialog the page raises; Playwright must not answer it.

    // alert: one button, the page's words, its origin in the header, and the script resumes after OK.
    const alerting = view.click('#alert')
    const alertPanel = await waitQuestionSaying(app, 'Hello there')
    const alerted = await readQuestion(alertPanel)
    expect(alerted.origin).toBe(`${origin} says`)
    expect(alerted.buttons).toEqual(['OK'])
    await answerQuestion(app, 'OK')
    await alerting
    expect(await read<boolean>(view, 'alerted')).toBe(true)

    // confirm: the page reads true for OK and false for Cancel.
    const confirming = view.click('#confirm')
    await waitQuestionSaying(app, 'Delete everything?')
    await answerQuestion(app, 'OK')
    await confirming
    expect(await read<boolean>(view, 'confirmed')).toBe(true)
    const declining = view.click('#confirm')
    await waitQuestionSaying(app, 'Delete everything?')
    await answerQuestion(app, 'Cancel')
    await declining
    expect(await read<boolean>(view, 'confirmed')).toBe(false)

    // prompt: the text typed in the panel comes back, with the page's default as the starting text.
    const prompting = view.click('#prompt')
    const promptPanel = await waitQuestionSaying(app, 'Your name?')
    expect(await promptPanel.inputValue('.q-input')).toBe('anon')
    await promptPanel.fill('.q-input', 'Ada')
    await answerQuestion(app, 'OK')
    await prompting
    expect(await read<string>(view, 'typed')).toBe('Ada')
    const cancelling = view.click('#prompt')
    await waitQuestionSaying(app, 'Your name?')
    await answerQuestion(app, 'Cancel')
    await cancelling
    expect(await read<string | null>(view, 'typed')).toBeNull()

    // A loop, on a fresh document: the third dialog offers to stop the rest; ticking it answers the fourth and fifth without a panel.
    await view.reload()
    const looping = view.click('#loop')
    await waitQuestionSaying(app, 'one')
    await answerQuestion(app, 'OK')
    const second = await waitQuestionSaying(app, 'two')
    expect(await second.locator('.q-check').count()).toBe(0)
    await answerQuestion(app, 'OK')
    const third = await waitQuestionSaying(app, 'three')
    expect(await third.locator('.q-check').count()).toBe(1)
    await third.check('.q-check input')
    await answerQuestion(app, 'OK')
    await looping
    expect(await read<boolean[]>(view, 'loop')).toEqual([true, true, true, false, false])
    expect(await questionGone(app)).toBe(true)

    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('speaks for a frame by its own origin, asks a frame the page made itself, and releases a script whose tab navigates away', async () => {
  const { origin, frameOrigin } = await serve()
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${origin}/`)
    view.on('dialog', () => {}) // The debugger reports every dialog the page raises; Playwright must not answer it.
    await view.waitForSelector('iframe')

    // A cross-origin frame: the panel says an embedded page speaks, on the frame's own origin.
    const asking = view.click('#ask-frame')
    const panel = await waitQuestionSaying(app, 'the frame asks')
    expect((await readQuestion(panel)).origin).toBe(`An embedded page on ${frameOrigin} says`)
    await answerQuestion(app, 'OK')
    await asking
    expect(await waitFor(async () => await read<string | undefined>(view, 'frameAnswer') === 'answered:true')).toBe(true)

    // A blank frame the page makes has no document of its own: its confirm is asked, and the page reads the answer.
    const blanking = view.click('#blank')
    const blankPanel = await waitQuestionSaying(app, 'blank')
    expect((await readQuestion(blankPanel)).origin).toMatch(/^An embedded page/)
    await answerQuestion(app, 'OK')
    await blanking
    expect(await read<boolean>(view, 'blank')).toBe(true)

    // A question for a tab that is not in front waits for it.
    await view.click('#later')
    await runCommand(chrome, 'tab.new')
    await delay(ABSENCE_SETTLE_MS * 2)
    expect(await questionGone(app)).toBe(true)
    await runCommand(chrome, 'tab.close')
    await waitQuestionSaying(app, 'later?')
    await answerQuestion(app, 'OK')
    expect(await waitFor(async () => await read<boolean | undefined>(view, 'later') === true)).toBe(true)

    // The address bar goes elsewhere while the page is held: the dialog is dropped, the script released, the new page shows.
    const holding = view.click('#hold').catch(() => undefined)
    await waitQuestionSaying(app, 'hold on')
    await clickAddressBarRetrying(chrome, `${origin}/next`)
    const moved = await waitForTab(chrome, { address: `${origin}/next`, title: 'next page' })
    expect(moved.ok).toBe(true)
    await holding
    expect(await waitFor(async () => await questionGone(app))).toBe(true)

    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('keeps a page that asks before it is left, and lets a second attempt through after Leave', async () => {
  const { origin } = await serve()
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${origin}/`)
    view.on('dialog', () => {}) // The debugger reports every dialog the page raises; Playwright must not answer it.
    await view.click('#guard')

    // The page's own navigation: Stay keeps it, and the question is in the panel.
    await view.click('#go', { noWaitAfter: true })
    const panel = await waitQuestionSaying(app, 'Leave this page?')
    expect((await readQuestion(panel)).buttons).toEqual(['Stay', 'Leave'])
    await answerQuestion(app, 'Stay')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await view.evaluate(() => document.title)).toBe('Dialogs fixture')

    // Leave does not move a page that navigated itself: the person clicks again, and that attempt is not asked.
    await view.evaluate(() => { document.getElementById('go')?.click() }) // The page's own navigation is still counted pending by the driver, which would make a click wait for it.
    await waitQuestionSaying(app, 'Leave this page?')
    await answerQuestion(app, 'Leave')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await view.evaluate(() => document.title)).toBe('Dialogs fixture')
    await view.evaluate(() => { document.getElementById('go')?.click() }) // The page's own navigation is still counted pending by the driver, which would make a click wait for it.
    const moved = await waitForTab(chrome, { address: `${origin}/next`, title: 'next page' })
    expect(moved.ok).toBe(true)
    expect(await questionGone(app)).toBe(true)

    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

/** What a frame can reach that only the top frame of a tab is given. */
const exposure = (): Record<string, unknown> => ({
  orivon: typeof (globalThis as Record<string, unknown>).orivon,
  process: typeof (globalThis as Record<string, unknown>).process,
  buffer: typeof (globalThis as Record<string, unknown>).Buffer,
  fetchIsNative: /\[native code\]/.test(Function.prototype.toString.call(fetch))
})

it('gives a frame no preload, and honours what Chromium refuses a page: a sandbox, and the page being left', async () => {
  const { origin, frameOrigin } = await serve()
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${origin}/`)
    view.on('dialog', () => {}) // The debugger reports every dialog the page raises; Playwright must not answer it.
    await view.waitForSelector('iframe[name=sandboxed]')
    await waitFor(() => view.frames().filter((frame) => frame.name() !== '').length >= 2)

    // The top frame has the surface; no frame has any of it, because a tab's preload runs in the top frame only.
    expect(await view.evaluate(exposure)).toEqual({ orivon: 'object', process: 'undefined', buffer: 'undefined', fetchIsNative: true })
    const same = view.frames().find((frame) => frame.name() === 'same')
    expect(same).toBeDefined()
    expect(await same?.evaluate(exposure)).toEqual({ orivon: 'undefined', process: 'undefined', buffer: 'undefined', fetchIsNative: true })
    const cross = view.frames().find((frame) => frame.url().startsWith(`${frameOrigin}/frame`) && frame.name() === '')
    expect(cross).toBeDefined()
    expect(await cross?.evaluate(exposure)).toEqual({ orivon: 'undefined', process: 'undefined', buffer: 'undefined', fetchIsNative: true })

    // A document sandboxed without allow-modals has its dialogs ignored by Chromium itself: answered no, no panel.
    await view.click('#ask-sandboxed')
    expect(await waitFor(async () => await read<string | undefined>(view, 'frameAnswer') === 'answered:false')).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)

    // A page being left cannot put its own words in front of the person: its dialogs during beforeunload and pagehide are ignored, and the navigation goes on.
    await view.click('#dismissal')
    await view.evaluate(() => { document.getElementById('go')?.click() }) // The page's own navigation is still counted pending by the driver, which would make a click wait for it.
    const moved = await waitForTab(chrome, { address: `${origin}/next`, title: 'next page' })
    expect(moved.ok).toBe(true)
    expect(await questionGone(app)).toBe(true)

    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('ends the panel of a frame in its own process when the page removes the frame', async () => {
  // 127.0.0.2 is another site than 127.0.0.1, so its frame lives in a process of its own and the page stays free to act.
  const far = createServer((_request, response) => { html(response, FRAME) })
  await new Promise<void>((resolve) => { far.listen(0, '127.0.0.2', resolve) })
  const farOrigin = `http://127.0.0.2:${String((far.address() as AddressInfo).port)}`
  const main = await startServer((_request, response) => {
    html(response, `<!doctype html><title>Removal fixture</title><body>
<button id="ask-far" onclick="frames[0].postMessage('ask', '*')">ask</button>
<button id="remove" onclick="document.querySelector('iframe').remove()">remove</button>
<iframe src="${farOrigin}/frame"></iframe></body>`)
  })
  servers.push(main, { origin: farOrigin, close: async () => { await new Promise<void>((resolve) => { far.close(() => { resolve() }); far.closeAllConnections() }) } })
  const { app, chrome } = await launchShell({ args: [`${HERMETIC_RESOLVER}, EXCLUDE 127.0.0.2`] })
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${main.origin}/`)
    view.on('dialog', () => {}) // The debugger reports every dialog the page raises; Playwright must not answer it.
    await view.waitForSelector('iframe')
    await waitFor(() => view.frames().some((frame) => frame.url().startsWith(farOrigin)))

    await view.click('#ask-far')
    const panel = await waitQuestionSaying(app, 'the frame asks')
    expect((await readQuestion(panel)).origin).toBe(`An embedded page on ${farOrigin} says`)

    await view.click('#remove')
    expect(await waitFor(async () => await questionGone(app))).toBe(true)

    expect(await noNativeDialogs(app)).toEqual([])
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)

it('gives a top-level document sandboxed by its own policy no prompt, no confirm and no panel', async () => {
  const { origin } = await serve()
  const { app, chrome } = await launchShell()
  try {
    await stubNativeDialogs(app)
    const view = await visit(app, chrome, `${origin}/csp-sandbox`)
    view.on('dialog', () => {})
    await view.click('#ask')
    expect(await waitFor(async () => JSON.stringify(await read<unknown>(view, 'results')) === '[null,false]')).toBe(true)
    await delay(ABSENCE_SETTLE_MS)
    expect(await questionGone(app)).toBe(true)
    expect(await noNativeDialogs(app)).toEqual([])
  } finally {
    await closeElectron(app)
  }
}, E2E_TIMEOUT_MS)
