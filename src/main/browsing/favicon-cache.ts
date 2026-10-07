// favicon-fetch.ts's memory of icons it has already fetched, as `data:` URLs keyed
// by the candidate URL asked for. Pure, so it is tested with no Electron.

/** Least recently used dropped first, bounded by entry count and by total
 * characters, because any page can name any number of icon URLs and each
 * `data:` URL can run to ~171 KiB. */
export class FaviconCache {
  private readonly entries = new Map<string, string>()
  private chars = 0

  constructor (private readonly maxEntries: number, private readonly maxChars: number) {}

  get (url: string): string | undefined {
    const dataUrl = this.entries.get(url)
    if (dataUrl === undefined) return undefined
    // Re-inserted so the Map's own insertion order stays least recently used first.
    this.entries.delete(url)
    this.entries.set(url, dataUrl)
    return dataUrl
  }

  set (url: string, dataUrl: string): void {
    if (dataUrl.length > this.maxChars) return
    this.forget(url)
    this.entries.set(url, dataUrl)
    this.chars += dataUrl.length
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries && this.chars <= this.maxChars) break
      this.forget(oldest)
    }
  }

  private forget (url: string): void {
    const dataUrl = this.entries.get(url)
    if (dataUrl === undefined) return
    this.entries.delete(url)
    this.chars -= dataUrl.length
  }
}
