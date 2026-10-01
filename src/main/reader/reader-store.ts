// The article each reader tab shows, held in memory only. The key is the reader tab's record, so the article goes
// with the tab when it moves to another window; `token` tells a late picture which showing it belongs to.
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

  get (key: object): ReaderEntry | undefined {
    return this.entries.get(key)
  }

  /** Replaces what the tab shows and returns the new entry. */
  set (key: object, article: Article, links: readonly string[], source: string): ReaderEntry {
    this.counter += 1
    const entry: ReaderEntry = { article, links, source, images: new Map(), token: this.counter }
    this.entries.set(key, entry)
    return entry
  }

  delete (key: object): void {
    this.entries.delete(key)
  }
}

export const readerArticles = new ReaderArticles()
