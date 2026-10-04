import { blockedSiteKindIcon } from '../pages/shared/site-kind-icons.js'
import type { ChromeModule } from './context.js'

export const POPUPS_LABEL = 'Pop-ups blocked on this page'

/** What the badge says: nothing for one, the number up to nine, then "9+". */
export function countText (count: number): string {
  if (count <= 1) return ''
  return count > 9 ? '9+' : String(count)
}

/** The mark in the address bar for a page whose pop-ups were blocked: it opens the bubble that lists them. */
export function createPopupsChip (): ChromeModule {
  let chip: HTMLButtonElement | undefined
  let badge: HTMLSpanElement | undefined

  return {
    name: 'popups-chip',
    init: (ctx) => {
      chip = ctx.toolbarButton({
        id: 'popups-chip',
        slot: 'address',
        order: 12,
        label: POPUPS_LABEL,
        icon: () => blockedSiteKindIcon('popups'),
        onClick: (el) => { void ctx.shell.act('overlay.toggle', { name: 'popups-blocked', anchor: ctx.anchorFor(el) }) },
        presses: 'popups-blocked'
      })
      chip.hidden = true
      chip.setAttribute('aria-haspopup', 'dialog')
      badge = document.createElement('span')
      badge.className = 'popups-count'
      badge.setAttribute('aria-hidden', 'true')
      badge.hidden = true
      chip.append(badge)
    },
    render: (state) => {
      if (chip === undefined || badge === undefined) return
      const count = state.popupsBlocked
      chip.hidden = count < 1
      const text = countText(count)
      badge.hidden = text === ''
      badge.textContent = text
      const label = count > 1 ? `${POPUPS_LABEL}: ${String(count)}` : POPUPS_LABEL
      chip.title = label
      chip.setAttribute('aria-label', label)
    }
  }
}
