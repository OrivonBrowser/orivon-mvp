// A Chromium `Bookmarks` file as two lists of nodes, the bar and Other bookmarks. Pure: the text in, the
// tree out. Nothing in the file is trusted: every field is checked for its type, and what is built is bounded.
import type { BookmarkTreeInput } from '../browsing/bookmark-types.js'
import { ImportError } from './import-types.js'
import type { SourceBookmarks } from './import-types.js'
import { clipTitle, leavesOf, NodeBudget, tooDeep } from './source-tree.js'

/** Chromium counts microseconds from 1601; the bookmarks store counts milliseconds from 1970. */
const WEBKIT_EPOCH_OFFSET_MS = 11_644_473_600_000

interface ChromiumNode {
  readonly type?: unknown
  readonly name?: unknown
  readonly url?: unknown
  readonly date_added?: unknown
  readonly children?: unknown
}

export function webkitToUnixMs (value: unknown): number | undefined {
  const micros = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN
  if (!Number.isFinite(micros)) return undefined
  const ms = Math.trunc(micros / 1000 - WEBKIT_EPOCH_OFFSET_MS)
  return ms > 0 ? ms : undefined
}

const isObject = (value: unknown): value is ChromiumNode => typeof value === 'object' && value !== null
const childrenOf = (node: ChromiumNode): readonly ChromiumNode[] => Array.isArray(node.children) ? node.children.filter(isObject) : []
const isPage = (node: ChromiumNode): boolean => node.type === 'url'

function pageOf (node: ChromiumNode): BookmarkTreeInput {
  const added = webkitToUnixMs(node.date_added)
  return { kind: 'url', title: clipTitle(node.name), url: typeof node.url === 'string' ? node.url : '', ...(added === undefined ? {} : { added }) }
}

function convert (nodes: readonly ChromiumNode[], depth: number, budget: NodeBudget, out: BookmarkTreeInput[]): void {
  for (const node of nodes) {
    if (isPage(node)) {
      if (budget.take()) out.push(pageOf(node))
    } else if (node.type === 'folder' || Array.isArray(node.children)) {
      if (tooDeep(depth)) {
        out.push(...leavesOf<ChromiumNode>(node, childrenOf, isPage, pageOf, budget))
      } else if (budget.take()) {
        const added = webkitToUnixMs(node.date_added)
        const children: BookmarkTreeInput[] = []
        convert(childrenOf(node), depth + 1, budget, children)
        out.push({ kind: 'folder', title: clipTitle(node.name), ...(added === undefined ? {} : { added }), children })
      }
    }
  }
}

/** The bar's items and Other bookmarks' (with Mobile bookmarks as a folder inside it). Throws `format` for text that is not a bookmarks file. */
export function parseChromiumBookmarks (text: string): SourceBookmarks {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ImportError('format')
  }
  const roots = isObject(parsed) ? (parsed as { roots?: unknown }).roots : undefined
  if (!isObject(roots)) throw new ImportError('format')
  const root = roots as Record<string, unknown>
  const budget = new NodeBudget()
  const bar: BookmarkTreeInput[] = []
  const other: BookmarkTreeInput[] = []
  if (isObject(root['bookmark_bar'])) convert(childrenOf(root['bookmark_bar']), 1, budget, bar)
  if (isObject(root['other'])) convert(childrenOf(root['other']), 1, budget, other)
  if (isObject(root['synced'])) {
    const mobile: BookmarkTreeInput[] = []
    convert(childrenOf(root['synced']), 2, budget, mobile)
    if (mobile.length > 0) other.push({ kind: 'folder', title: 'Mobile bookmarks', children: mobile })
  }
  return { bar, other }
}
