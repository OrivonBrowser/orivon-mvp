// What an end-to-end spec uses to drive the question panel (src/main/shell/question/) and to prove that no native
// message box was opened. A question is answered the way a person answers it: the real button on the real panel,
// after the guard that keeps a stray click or key from landing on it.
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { delay, popoverShown, waitFor } from './smoke-helpers.mjs'

type App = ElectronApplication

/**
 * Replaces the native dialog methods with recorders that answer "cancelled" (or button 2, for a message box), so a
 * stray native box neither hangs the run nor goes unnoticed. `pickers` lets an OS picker answer a path instead.
 */
export async function stubNativeDialogs (app: App, pickers: { open?: string[], save?: string } = {}): Promise<void> {
  await app.evaluate(({ dialog }, answers) => {
    const g = globalThis as unknown as { __nativeDialogs: string[] }
    g.__nativeDialogs = []
    const record = (name: string) => (): unknown => {
      g.__nativeDialogs.push(name)
      if (name === 'showMessageBoxSync') return 2
      if (name === 'showErrorBox') return undefined
      if (name === 'showOpenDialog' && answers.open !== undefined) return Promise.resolve({ canceled: false, filePaths: answers.open })
      if (name === 'showSaveDialog' && answers.save !== undefined) return Promise.resolve({ canceled: false, filePath: answers.save })
      return Promise.resolve({ response: 2, checkboxChecked: false, canceled: true, filePaths: [], filePath: '' })
    }
    for (const name of ['showMessageBox', 'showMessageBoxSync', 'showErrorBox', 'showOpenDialog', 'showSaveDialog']) {
      ;(dialog as unknown as Record<string, unknown>)[name] = record(name)
    }
  }, pickers)
}

/** The native dialog methods called since `stubNativeDialogs`. */
export async function nativeDialogsAsked (app: App): Promise<string[]> {
  return await app.evaluate(() => (globalThis as unknown as { __nativeDialogs?: string[] }).__nativeDialogs ?? [])
}

/** The native message boxes asked: always empty while every question is asked in the panel. Spec files end on `expect(await noNativeDialogs(app)).toEqual([])`. */
export async function noNativeDialogs (app: App): Promise<string[]> {
  return (await nativeDialogsAsked(app)).filter((name) => name !== 'showOpenDialog' && name !== 'showSaveDialog')
}

const questionPages = (app: App): Page[] => app.windows().filter((page) => page.url().includes('overlay=question') && !page.isClosed())

/** Whether the panel is on screen. A build without the e2e popover hook (the ordinary build) has none to ask: its question page lives only while its question is open, so the page existing is the answer. */
async function questionShown (app: App): Promise<boolean> {
  const hooked = await app.evaluate(() => (globalThis as unknown as { __orivonDevPopoverShown?: unknown }).__orivonDevPopoverShown !== undefined)
  return hooked ? await popoverShown(app, 'overlay=question') : questionPages(app).length > 0
}

/** The question panel that is on screen and has drawn. */
export async function waitQuestion (app: App, timeoutMs = 20_000): Promise<Page> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    if (!(await questionShown(app))) return false
    const candidate = questionPages(app).at(-1)
    if (candidate === undefined) return false
    try {
      await candidate.waitForSelector('.q .btn-row .btn', { timeout: 2_000 })
      found = candidate
      return true
    } catch {
      return false
    }
  }, timeoutMs)
  expect(ok).toBe(true)
  return found as Page
}

/** Whether no question panel is on screen. */
export async function questionGone (app: App): Promise<boolean> {
  return !(await questionShown(app))
}

export interface QuestionText { origin: string, title: string, message: string, detail: string, buttons: string[], warning: boolean }

/** What the panel says, as the person reads it. */
export async function readQuestion (page: Page): Promise<QuestionText> {
  return await page.evaluate(() => {
    const text = (selector: string): string => document.querySelector(selector)?.textContent ?? ''
    return {
      origin: text('.q-origin'),
      title: text('.q-title'),
      message: text('.q-message'),
      detail: text('.q-detail'),
      buttons: Array.from(document.querySelectorAll('.q .btn-row .btn')).map((button) => button.textContent ?? ''),
      warning: document.querySelector('.q.q-warning') !== null
    }
  })
}

/** Waits out the guard, then presses the button with this label. The panel may already be gone by the time the click settles. */
export async function answerQuestion (app: App, label: string): Promise<void> {
  const page = await waitQuestion(app)
  await page.waitForSelector('.q:not(.arming)')
  try {
    await page.click(`.q .btn-row .btn:text-is("${label}")`)
  } catch (error) {
    if (!/closed|destroyed/.test(String(error))) throw error
  }
}

/** Waits for the panel and answers it, returning what it said first. */
export async function answerAndRead (app: App, label: string): Promise<QuestionText> {
  const page = await waitQuestion(app)
  const said = await readQuestion(page)
  await answerQuestion(app, label)
  return said
}

/** Waits for the panel and presses its first listed button, the accepting one in every consent question (`Allow`, or `Allow all` where the app asked per capability), returning what it said first. */
export async function answerAccepting (app: App): Promise<QuestionText> {
  const page = await waitQuestion(app)
  const said = await readQuestion(page)
  await page.waitForSelector('.q:not(.arming)')
  try {
    await page.click('.q .btn-row .btn[data-button="0"]')
  } catch (error) {
    if (!/closed|destroyed/.test(String(error))) throw error
  }
  return said
}

/**
 * Runs `work` (typically a call that blocks until a person has answered) and answers every question the panel raises
 * meanwhile with the button labelled `label`, returning what `work` returns. For installs driven through a test hook
 * that await the person's answer.
 */
export async function answeringWith<T> (app: App, label: string, work: Promise<T>): Promise<T> {
  let done = false
  const result = work.finally(() => { done = true })
  const answers = (async () => {
    while (!done) {
      if (!(await questionShown(app).catch(() => false))) { await delay(100); continue }
      const page = questionPages(app).at(-1)
      if (page === undefined) { await delay(100); continue }
      try {
        await page.waitForSelector('.q:not(.arming)', { timeout: 3_000 })
        await page.click(`.q .btn-row .btn:text-is("${label}")`, { timeout: 3_000 })
      } catch {
        // The panel closed under the click, or `work` ended it: the loop's own check decides whether to go on.
      }
      await delay(100)
    }
  })()
  const value = await result
  await answers
  return value
}

/**
 * Answers every question the panel raises from now on with its first listed button (the accepting one, in every consent
 * question) until `stop` is called or the app closes, and records what each one said. For a spec whose subject is
 * not the question: it only has to be let through.
 */
export function answerEveryQuestion (app: App): { seen: QuestionText[], stop: () => void } {
  const seen: QuestionText[] = []
  let stopped = false
  app.on('close', () => { stopped = true })
  void (async () => {
    while (!stopped) {
      await delay(150)
      try {
        if (!(await questionShown(app))) continue
        const page = questionPages(app).at(-1)
        if (page === undefined) continue
        await page.waitForSelector('.q:not(.arming) .btn-row .btn', { timeout: 3_000 })
        const said = await readQuestion(page)
        await page.click('.q .btn-row .btn[data-button="0"]', { timeout: 3_000 })
        seen.push(said)
      } catch {
        // The panel closed under the click, or the app is closing: the loop's own check decides whether to go on.
      }
    }
  })()
  return { seen, stop: () => { stopped = true } }
}
