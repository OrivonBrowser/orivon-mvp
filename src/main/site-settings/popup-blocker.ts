// The pop-up blocker the window-open handler asks. It joins the person's
// recent input (`tab-interaction.ts`), the site's answer and the rule
// (`popup-policy.ts`), and remembers what it refused (`popup-blocks.ts`) for
// the chip. `popups.ts` reaches it through the `popupBlocker` of this process,
// bound by the installer; before then nothing is blocked. No `electron`
// import: a tab is used only through `on`.
import { decidePopup } from './popup-policy.js'
import type { ContentRules } from './content-rules.js'
import type { PopupBlocks, NavigatingTab } from './popup-blocks.js'
import type { InputTab, TabInteraction } from './tab-interaction.js'

type Tab = InputTab & NavigatingTab & object

export interface PopupBlockerDeps<T extends Tab> {
  readonly rules: ContentRules
  readonly interaction: TabInteraction<T>
  readonly blocks: PopupBlocks<T>
  readonly clock?: () => number
}

export interface PopupBlocker<T extends Tab> {
  /** Whether the window `tab`'s page, now at `openerUrl`, is opening toward `targetUrl` is refused. A refusal is recorded for the chip. */
  check: (tab: T, openerUrl: string, targetUrl: string) => boolean
  /** Starts listening to a tab's input, ahead of the first window it might open. */
  watch: (tab: T) => void
}

export function createPopupBlocker<T extends Tab> (deps: PopupBlockerDeps<T>): PopupBlocker<T> {
  const clock = deps.clock ?? Date.now
  return {
    watch: (tab) => { deps.interaction.watch(tab) },
    check: (tab, openerUrl, targetUrl) => {
      // No value: the opener is not a website, or is a registered app.
      const value = deps.rules.valueFor('popups', openerUrl)
      if (value === undefined) return false
      deps.interaction.watch(tab)
      const { at, consumed } = deps.interaction.read(tab)
      const verdict = decidePopup({
        value,
        lastInteractionAt: at,
        now: clock(),
        consumed
      })
      if (verdict === 'allow') {
        deps.interaction.consume(tab)
        return false
      }
      deps.blocks.add(tab, targetUrl)
      return true
    }
  }
}
