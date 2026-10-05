// Shared plumbing for e2e-the-lounge-real.test.ts: where the port lives, how the page it shows in its
// <webview> is driven, and how a launch's files are read from disk. The port is the sibling repository's
// (`orivon-ports`), so nothing here may import from it.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { launchElectron } from '../support/launch-electron.mjs'
import { findChrome, findViewShowing, tabViews, waitFor } from '../support/smoke-helpers.mjs'
import { answerEveryQuestion, stubNativeDialogs, type QuestionText } from '../support/question-support.js'

export const PORTS_ROOT = process.env['ORIVON_PORTS_ROOT'] ?? join(process.cwd(), '..', 'orivon-ports')
export const STATIC_ROOT = process.env['ORIVON_THE_LOUNGE_ROOT'] ?? join(PORTS_ROOT, 'out', 'the-lounge', 'static')
export const BUILT = existsSync(join(STATIC_ROOT, 'index.html')) && existsSync(join(STATIC_ROOT, 'server.mjs'))

/** The static server's port (free on this machine: not the ports checkout's own 8890, nor the other apps' fixed ones). */
export const SERVE_PORT = Number(process.env['ORIVON_THE_LOUNGE_SERVE_PORT'] ?? 8894)
export const ORIGIN = `http://127.0.0.1:${String(SERVE_PORT)}`
/** The port orivon.json fixes for the server's listener, and the address of the page it serves. */
export const LOUNGE_PORT = 9000
export const LOUNGE_URL = `http://lounge.localhost:${String(LOUNGE_PORT)}/`
/** The fake IRC server's port: a loopback port the port's orivon.json names exactly, since the broker reserves 6667 from any range. */
export const IRC_PORT = 6667
/** The TLS fake's port: The Lounge's form moves to 6697 with TLS on, and orivon.json names `localhost:6697` exactly. */
export const IRC_TLS_PORT = 6697

export const ACCOUNT = { name: 'orivon-tester', password: 'correct horse battery staple' }
export const CHANNEL = '#orivon'
export const NICK = 'orivon-e2e'

type Page = ReturnType<typeof findChrome>

/** Runs `code` in the page shown by the launcher's `<webview>` and returns its result. */
export async function inLounge<T> (launcher: Page, code: string): Promise<T> {
  return await launcher.evaluate(async (source: string) => {
    const view = document.querySelector('webview') as unknown as { executeJavaScript: (code: string) => Promise<unknown> } | null
    if (view === null) throw new Error('the launcher has no <webview>')
    return await view.executeJavaScript(source)
  }, code) as T
}

/** `inLounge`, false on any failure: for polling a page that is mid-load. */
export async function loungeHolds (launcher: Page, expression: string): Promise<boolean> {
  try {
    return await inLounge<boolean>(launcher, `Boolean(${expression})`)
  } catch {
    return false
  }
}

export async function waitLounge (launcher: Page, expression: string, ms: number): Promise<boolean> {
  return await waitFor(async () => await loungeHolds(launcher, expression), ms)
}

/** Sets a field's value the way typing does, so Vue's `v-model` hears it. */
export function fillScript (selector: string, value: string | boolean): string {
  return `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) throw new Error('no element ' + ${JSON.stringify(selector)})
    const key = el.type === 'checkbox' ? 'checked' : 'value'
    Object.getOwnPropertyDescriptor(el.constructor.prototype, key).set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event(key === 'checked' ? 'change' : 'input', { bubbles: true }))
    return true
  })()`
}

/** The launcher's own tab view: the one showing `ORIGIN`, whichever tab it is. */
export function launcherViews (app: ElectronApplication, chrome: Page): Page[] {
  return (tabViews(app, chrome) as Page[]).filter((view: Page) => view.url().startsWith(ORIGIN))
}

export function launcherView (app: ElectronApplication, chrome: Page): Page | undefined {
  return findViewShowing(app, chrome, `${ORIGIN}/`) ?? launcherViews(app, chrome)[0]
}

/** Every file under `dir` whose name ends with `suffix`, with its size. Null-safe when `dir` does not exist. */
export function filesEnding (dir: string, suffix: string, into: Array<{ path: string, size: number }> = []): Array<{ path: string, size: number }> {
  let names: string[]
  try { names = readdirSync(dir) } catch { return into }
  for (const name of names) {
    const path = join(dir, name)
    let stat
    try { stat = statSync(path) } catch { continue }
    if (stat.isDirectory()) filesEnding(path, suffix, into)
    else if (name.endsWith(suffix)) into.push({ path, size: stat.size })
  }
  return into
}

/** Every console line and page error of every page the app has, oldest first, each tagged with the page it came from. */
export function collectPageLogs (app: ElectronApplication): string[] {
  const lines: string[] = []
  const seen = new WeakSet<object>()
  const attach = (page: Page): void => {
    if (seen.has(page)) return
    seen.add(page)
    const tag = (): string => page.url().replace(ORIGIN, '').slice(0, 40) || 'page'
    page.on('console', (message: { type: () => string, text: () => string }) => { lines.push(`[${tag()}] ${message.type()}: ${message.text().slice(0, 400)}`) })
    page.on('pageerror', (error: Error) => { lines.push(`[${tag()}] pageerror: ${error.message.slice(0, 400)}`) })
    page.on('requestfailed', (request: { url: () => string, failure: () => { errorText: string } | null }) => { lines.push(`[${tag()}] requestfailed: ${request.url().slice(0, 160)} ${request.failure()?.errorText ?? ''}`) })
  }
  for (const page of app.windows()) attach(page)
  app.context().on('page', attach)
  return lines
}

/** `promise`, or `fallback` when it has not settled in `ms` (a busy or hidden page answers a Playwright call late or never). */
export async function within<T, F> (promise: Promise<T>, ms: number, fallback: F): Promise<T | F> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise.catch(() => fallback), new Promise<F>((resolve) => { timer = setTimeout(() => { resolve(fallback) }, ms) })])
  } finally {
    clearTimeout(timer)
  }
}

/** The launcher's status line, or '' when the page does not answer. */
export async function statusOf (launcher: Page): Promise<string> {
  return await within(launcher.evaluate(() => document.querySelector('#status')?.textContent ?? ''), 5_000, '')
}

/** The launcher's server-log panel, or '' when the page does not answer. */
export async function logOf (launcher: Page): Promise<string> {
  return await within(launcher.evaluate(() => document.querySelector('#log-text')?.textContent ?? ''), 5_000, '')
}

/** The page the launcher's `<webview>` shows, as a Playwright page: real clicks and keys reach it. */
export function loungePage (app: ElectronApplication): Page | undefined {
  return app.windows().find((page) => page.url().startsWith(`http://lounge.localhost:${String(LOUNGE_PORT)}/`))
}

const questionsSeen = new WeakMap<ElectronApplication, QuestionText[]>()

/** Lets every consent question the app raises through, pressing its first button, and records what each said. */
export async function answerConsent (app: ElectronApplication): Promise<void> {
  await stubNativeDialogs(app)
  questionsSeen.set(app, answerEveryQuestion(app).seen)
}

/** What each question said, for every question answered since `answerConsent`. */
export async function promptsSeen (app: ElectronApplication): Promise<Array<Record<string, unknown>>> {
  return (questionsSeen.get(app) ?? []).map((said) => ({ ...said }))
}

export type Launched = Awaited<ReturnType<typeof launchElectron>>

/**
 * Types `text` into the field at `selector` of a page a `<webview>` shows, key by key. `Page.fill` sets nothing
 * there: the guest has no focus until something in it is clicked, so the field is clicked first.
 */
export async function typeInto (page: Page, selector: string, text: string): Promise<void> {
  await page.click(selector)
  await page.keyboard.press('Control+A')
  await page.keyboard.press('Backspace')
  await page.keyboard.type(text)
}
