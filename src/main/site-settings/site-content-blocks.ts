// Whether a page's site has JavaScript, images or sound switched off, for the
// mark on the address bar's key. The chrome's state is read on every push, so
// the answer has to be reachable without a store in hand: the installer binds
// the rule at start and announces a change; before then nothing is blocked.
// No `electron` import.
type BlockRule = (pageUrl: string) => boolean

let rule: BlockRule = () => false
const listeners = new Set<() => void>()

export const siteContentBlocks = {
  bind (next: BlockRule): void { rule = next },
  /** True when the page at `pageUrl` is on a site with at least one of the three switched off. */
  blocked (pageUrl: string): boolean {
    try { return rule(pageUrl) } catch (error) { console.error('[site-content-blocks] the rule failed:', error); return false }
  },
  /** Calls `listener` after a setting that can change an answer; returns the stop. */
  onChange (listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  changed (): void {
    for (const listener of [...listeners]) {
      try { listener() } catch (error) { console.error('[site-content-blocks] a listener failed:', error) }
    }
  }
}
