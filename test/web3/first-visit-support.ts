// What the first-visit specs share: an app published to the fixture gateway with the hash tree it declares,
// the facts about a page read from main, and the app-setup sheet read and pressed the way a person does.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { bundleTreeFromLeaves } from '../../src/broker/policy/bundle-hash.js'
import { originHash, partitionFor } from '../../src/broker/grants/origin-hash.js'
import { leafOf } from '../../src/loader/leaf-hash.js'
import { waitFor } from '../support/smoke-helpers.mjs'

type App = ElectronApplication

const enc = (text: string): Uint8Array => new TextEncoder().encode(text)

/** An app's files with `/.well-known/orivon-ddoc.json` added: the tree of the files as given, or of `declared` when the site declares files other than the ones it serves. */
export async function withDeclaredTree (files: Record<string, string>, declared: Record<string, string> = files): Promise<Record<string, string>> {
  const entries = await Promise.all(Object.entries(declared).map(async ([path, content]) => {
    const canonical = `/${path}`
    const bytes = enc(content)
    return { path: canonical, byteLength: bytes.length, leaf: await leafOf(canonical, bytes.length, [bytes]) }
  }))
  const tree = await bundleTreeFromLeaves(entries)
  const leaves = Object.fromEntries(tree.assets.map((asset) => [asset.path, asset.leaf]))
  return { ...files, '.well-known/orivon-ddoc.json': JSON.stringify({ bundleHash: tree.root, leaves }) }
}

export interface PageFacts {
  readonly ran: string | null
  readonly hasProcess: boolean
}

/** What the newest page at `url` shows: whether its script ran, and whether it has the Node globals an app tab gets. Null when no page is there. */
export async function pageAt (app: App, url: string): Promise<PageFacts | null> {
  return await app.evaluate(async ({ webContents }, address) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    try {
      // A page that is being replaced never answers: a read that does not come back is no answer, and the caller asks again.
      const answered = await Promise.race([
        newest.executeJavaScript('({ ran: document.body?.dataset.app ?? null, hasProcess: typeof process !== "undefined" })') as Promise<{ ran: string | null, hasProcess: boolean }>,
        new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_500))
      ])
      return answered
    } catch {
      return null
    }
  }, url).catch(() => null)
}

/** Whether any page of the browser has committed a document at an address under `origin`. */
export async function anyDocumentAt (app: App, origin: string): Promise<boolean> {
  return await app.evaluate(({ webContents }, prefix) => webContents.getAllWebContents().some((contents) => {
    if (contents.isDestroyed()) return false
    const entry = contents.navigationHistory.getEntryAtIndex(contents.navigationHistory.getActiveIndex()) as { url: string } | null
    return entry?.url.startsWith(prefix) === true
  }), origin)
}

export function pinPath (userData: string, origin: string): string {
  return join(userData, 'apps', originHash(origin), 'pin.json')
}

/** The capabilities saved as granted to `origin`, or an empty list when nothing is saved. */
export function savedGrants (userData: string, origin: string): string[] {
  const file = join(userData, 'grants', originHash(origin), 'grants.json')
  if (!existsSync(file)) return []
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { grants?: Record<string, unknown> }
  return Object.keys(parsed.grants ?? {})
}

const sheetPages = (app: App): Page[] => app.windows().filter((page) => page.url().includes('overlay=app-setup-sheet') && !page.isClosed())
const coverPages = (app: App): Page[] => app.windows().filter((page) => page.url().includes('overlay=loading-screen') && !page.isClosed())

export interface SheetText { title: string, text: string, files: string[], buttons: string[] }

/** Waits for the app-setup sheet and reads it. */
export async function waitSheet (app: App, timeoutMs = 60_000): Promise<{ page: Page, text: SheetText }> {
  let found: Page | undefined
  const ok = await waitFor(async () => {
    const candidate = sheetPages(app).at(-1)
    if (candidate === undefined) return false
    try {
      await candidate.waitForSelector('.app-setup .btn-row .btn', { timeout: 2_000 })
      found = candidate
      return true
    } catch {
      return false
    }
  }, timeoutMs)
  expect(ok).toBe(true)
  const page = found as Page
  const text = await page.evaluate(() => ({
    title: document.querySelector('.sheet-title')?.textContent ?? '',
    text: document.querySelector('.app-setup')?.textContent ?? '',
    files: Array.from(document.querySelectorAll('.app-setup-files li')).map((item) => item.textContent ?? ''),
    buttons: Array.from(document.querySelectorAll('.app-setup .btn-row .btn')).map((button) => button.textContent ?? '')
  }))
  return { page, text }
}

export async function pressSheet (page: Page, label: string): Promise<void> {
  try {
    await page.click(`.app-setup .btn-row .btn:text-is("${label}")`)
  } catch (error) {
    if (!/closed|destroyed/.test(String(error))) throw error
  }
}

/** Whether no app-setup sheet is on screen. */
export function sheetGone (app: App): boolean {
  return sheetPages(app).length === 0
}

/** The setup cover's title, or null when none is up. */
export async function coverTitle (app: App): Promise<string | null> {
  const page = coverPages(app).at(-1)
  if (page === undefined) return null
  return await page.evaluate(() => document.querySelector('.loading-screen-title')?.textContent ?? null).catch(() => null)
}

/** Starts noting, in the main process, every page that finishes parsing and every line a page logs, so a spec can say what never happened. */
export async function watchPages (app: App): Promise<void> {
  await app.evaluate(({ app: electronApp }) => {
    const log: string[] = []
    ;(globalThis as { __pageLog?: string[] }).__pageLog = log
    electronApp.on('web-contents-created', (_event, contents) => {
      contents.on('dom-ready', () => { log.push(`dom-ready ${contents.getURL()}`) })
      contents.on('console-message', (...args: unknown[]) => {
        const first = args[0] as { message?: unknown } | undefined
        log.push(`console ${typeof first?.message === 'string' ? first.message : args.filter((arg) => typeof arg === 'string').join(' ')}`)
      })
    })
  })
}

/** What `watchPages` noted so far. */
export async function pageLog (app: App): Promise<string[]> {
  return await app.evaluate(() => [...((globalThis as { __pageLog?: string[] }).__pageLog ?? [])])
}

/** What the newest page at `url` says for `expression`, or null when none answers in time. */
export async function pageValue (app: App, url: string, expression: string): Promise<unknown> {
  return await app.evaluate(async ({ webContents }, [address, code]) => {
    const newest = webContents.getAllWebContents().filter((contents) => !contents.isDestroyed() && contents.getURL() === address).sort((a, b) => b.id - a.id)[0]
    if (newest === undefined) return null
    return await Promise.race([newest.executeJavaScript(code as string).catch(() => null), new Promise<null>((resolve) => setTimeout(() => { resolve(null) }, 2_500))])
  }, [url, expression] as const).catch(() => null)
}

/** Whether the app's own partition still holds `needle` in its local storage on disk, after what is unwritten was written. */
export async function partitionHolds (app: App, userData: string, origin: string, needle: string): Promise<boolean> {
  const partition = partitionFor(origin)
  await app.evaluate(async ({ session }, name) => { await session.fromPartition(name).flushStorageData() }, partition)
  const directory = join(userData, 'Partitions', partition.replace(/^persist:/, ''), 'Local Storage', 'leveldb')
  if (!existsSync(directory)) return false
  return readdirSync(directory).some((file) => readFileSync(join(directory, file)).includes(needle))
}
