// The article each window's reader tab shows, held in memory only. The key is the window's tab manager, so
// a closed window takes its article with it; `token` tells a late picture which showing it belongs to.
import type { Article } from './reader-blocks.js'

export interface ReaderEntry {
  readonly article: Article
  /** The addresses a link's index names, in the order the page draws them. */
  readonly links: readonly string[]
  /** The tab the article was taken from. */
  readonly source: string
  /** Pictures main has copied so far, by the place of their block. */
  readonly images: Map<number, string>
  readonly token: number
}

export class ReaderArticles {
  private readonly entries = new WeakMap<object, ReaderEntry>()
  private counter = 0

  get (window: object): ReaderEntry | undefined {
    return this.entries.get(window)
  }

  /** Replaces what the window shows and returns the new entry. */
  set (window: object, article: Article, links: readonly string[], source: string): ReaderEntry {
    this.counter += 1
    const entry: ReaderEntry = { article, links, source, images: new Map(), token: this.counter }
    this.entries.set(window, entry)
    return entry
  }

  delete (window: object): void {
    this.entries.delete(window)
  }
}

export const readerArticles = new ReaderArticles()
