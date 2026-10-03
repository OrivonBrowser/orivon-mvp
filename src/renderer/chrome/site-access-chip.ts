import type { ShellState } from '../../main/shell/tabs.js'
import { blockedSiteKindIcon, SITE_KIND_ICONS } from '../pages/shared/site-kind-icons.js'
import type { ChromeContext, ChromeModule } from './context.js'

type Access = ShellState['siteAccess']

/** What the chip shows for a page: the first blocked kind (blocked wins), else the first allowed one; null when nothing was decided. */
export function chipFor (access: Access): { kind: Access[number]['kind'], state: 'allowed' | 'blocked', label: string } | null {
  const pick = access.find((entry) => entry.state === 'blocked') ?? access[0]
  if (pick === undefined) return null
  return { kind: pick.kind, state: pick.state, label: `${pick.label} ${pick.state === 'blocked' ? 'blocked' : 'allowed'} on this page` }
}

/** The mark in the address bar for a page that asked for something: it says what was blocked or allowed and opens the bubble that changes it. */
export function createSiteAccessChip (): ChromeModule {
  let chip: HTMLButtonElement | undefined
  let painted = ''

  return {
    name: 'site-access',
    init: (ctx: ChromeContext) => {
      chip = ctx.toolbarButton({
        id: 'site-access-chip',
        slot: 'address',
        order: 10,
        label: 'Permissions on this page',
        icon: () => SITE_KIND_ICONS.camera(),
        onClick: (el) => { void ctx.shell.act('overlay.toggle', { name: 'site-prompt', anchor: ctx.anchorFor(el), payload: { mode: 'review' } }) },
        presses: 'site-prompt'
      })
      chip.hidden = true
      chip.setAttribute('aria-haspopup', 'dialog')
    },
    render: (state) => {
      if (chip === undefined) return
      const shown = chipFor(state.siteAccess)
      chip.hidden = shown === null
      if (shown === null) { painted = ''; return }
      // The strip is rebuilt on every push; the chip only when what it says changes, so the icon never flickers.
      const key = `${shown.kind}:${shown.state}`
      chip.classList.toggle('blocked', shown.state === 'blocked')
      chip.classList.toggle('allowed', shown.state === 'allowed')
      chip.title = shown.label
      chip.setAttribute('aria-label', shown.label)
      if (key === painted) return
      painted = key
      chip.replaceChildren(shown.state === 'blocked' ? blockedSiteKindIcon(shown.kind) : SITE_KIND_ICONS[shown.kind]())
    }
  }
}
