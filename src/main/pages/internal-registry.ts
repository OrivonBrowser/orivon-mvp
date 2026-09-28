// The webContents that are showing an internal page. A tab is an internal
// page because the shell made it one, so this is the record of that; nothing a
// page says about itself is consulted.
import type { WebContents } from 'electron'
import { INTERNAL_EVENT_CHANNEL } from '../channels.js'
import type { InternalPageId } from './internal-pages.js'

export class InternalPageRegistry {
  private readonly open = new Map<number, { contents: WebContents, page: InternalPageId }>()

  /** Forgotten when the contents are destroyed. */
  register (contents: WebContents, page: InternalPageId): void {
    const id = contents.id
    this.open.set(id, { contents, page })
    contents.once('destroyed', () => { this.open.delete(id) })
  }

  /** For contents that stop being an internal page while they live. */
  forget (contents: WebContents): void {
    if (!contents.isDestroyed()) this.open.delete(contents.id)
  }

  pageOf (contents: WebContents): InternalPageId | undefined {
    if (contents.isDestroyed()) return undefined
    const entry = this.open.get(contents.id)
    return entry?.contents === contents ? entry.page : undefined
  }

  /** Sends `topic` to every open internal page in `pages`. */
  publish (topic: string, payload: unknown, pages: readonly InternalPageId[]): void {
    for (const { contents, page } of this.open.values()) {
      if (pages.includes(page) && !contents.isDestroyed()) contents.send(INTERNAL_EVENT_CHANNEL, { topic, payload })
    }
  }
}
