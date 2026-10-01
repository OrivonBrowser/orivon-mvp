// Asks a page's isolated world whether the page is an article, and for the article. The library runs next to
// the page's DOM but out of reach of its scripts and its Content-Security-Policy; what comes back is JSON
// that reader-blocks.ts checks before anything uses it.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { WebContents } from 'electron'
import { validateArticle } from './reader-blocks.js'
import type { Article } from './reader-blocks.js'
import { walkReaderContent } from './reader-walk.js'

/** A world id nothing else in the shell uses. */
export const READER_WORLD_ID = 1010

/** A page that takes longer than this to answer is left alone. */
export const EXTRACT_MS = 3000

/** Pages with more markup than this are not parsed: the result would be a stall, not an article. */
const MAX_NODES = 60_000

export interface LibrarySources {
  readonly readability: string
  readonly readerable: string
}

let cached: LibrarySources | undefined

/** The library's two files, read once. They are text sent to a page, never bundled into one of Orivon's own pages. */
export function librarySources (): LibrarySources {
  if (cached !== undefined) return cached
  const require = createRequire(import.meta.url)
  cached = {
    readability: readFileSync(require.resolve('@mozilla/readability/Readability.js'), 'utf8'),
    readerable: readFileSync(require.resolve('@mozilla/readability/Readability-readerable.js'), 'utf8')
  }
  return cached
}

/** `typeof module` is "undefined" inside the wrapper, so the files only define their functions. */
export function readableScript (sources: LibrarySources): string {
  return `(function () {
  ${sources.readerable}
  try {
    if (document.getElementsByTagName('*').length > ${String(MAX_NODES)}) return 'false'
    return String(isProbablyReaderable(document))
  } catch (error) { return 'false' }
})()`
}

export function extractScript (sources: LibrarySources): string {
  return `(function () {
  ${sources.readerable}
  ${sources.readability}
  try {
    if (document.getElementsByTagName('*').length > ${String(MAX_NODES)}) return null
    if (!isProbablyReaderable(document)) return null
    var parsed = new Readability(document.cloneNode(true)).parse()
    if (!parsed || !parsed.content) return null
    var doc = new DOMParser().parseFromString(parsed.content, 'text/html')
    var walk = ${walkReaderContent.toString()}
    return JSON.stringify({
      title: parsed.title,
      byline: parsed.byline,
      site: parsed.siteName,
      lang: parsed.lang || document.documentElement.lang,
      blocks: walk(doc.body, 4000)
    })
  } catch (error) { return null }
})()`
}

type Runner = Pick<WebContents, 'executeJavaScriptInIsolatedWorld' | 'getURL' | 'isDestroyed' | 'isCrashed' | 'isLoading'>

function withTimeout<T> (work: Promise<T>, ms: number): Promise<T | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { resolve(undefined) }, ms)
    work.then((value) => { clearTimeout(timer); resolve(value) }, () => { clearTimeout(timer); resolve(undefined) })
  })
}

/** Whether a page is worth offering reader view for, or false for anything that cannot answer. */
export async function checkReadable (wc: Runner, sources: () => LibrarySources = librarySources): Promise<boolean> {
  if (wc.isDestroyed() || wc.isCrashed() || wc.isLoading()) return false
  const answer = await withTimeout(wc.executeJavaScriptInIsolatedWorld(READER_WORLD_ID, [{ code: readableScript(sources()) }]), EXTRACT_MS) as unknown
  return answer === 'true'
}

/** The page's article, or null when it has none, took too long, or was not what the validator accepts. */
export async function extractArticle (wc: Runner, sources: () => LibrarySources = librarySources): Promise<Article | null> {
  if (wc.isDestroyed() || wc.isCrashed()) return null
  const url = wc.getURL()
  const answer = await withTimeout(wc.executeJavaScriptInIsolatedWorld(READER_WORLD_ID, [{ code: extractScript(sources()) }]), EXTRACT_MS) as unknown
  if (typeof answer !== 'string') return null
  let raw: unknown
  try {
    raw = JSON.parse(answer)
  } catch {
    return null
  }
  return validateArticle(raw, url)
}
