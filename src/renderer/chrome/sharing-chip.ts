import type { ShellState } from '../../main/shell/tabs.js'
import { SITE_KIND_ICONS } from '../pages/shared/site-kind-icons.js'
import type { ChromeModule } from './context.js'

type Sharing = NonNullable<ShellState['sharing']>

const WHAT: Readonly<Record<Sharing['kind'], string>> = { screen: 'your screen', window: 'a window', tab: 'a tab' }

/** What the chip says: what the page is sharing and with whom; "and N more" when it has several shares. */
export function sharingLabel (sharing: Sharing): string {
  return `Sharing ${WHAT[sharing.kind]} with ${sharing.origin}${sharing.count > 1 ? ` and ${String(sharing.count - 1)} more` : ''}`
}

/** The mark in the address bar of a page that is sharing: it brings back the window's sharing bar if it was hidden. */
export function createSharingChip (): ChromeModule {
  let chip: HTMLButtonElement | undefined

  return {
    name: 'sharing-chip',
    init: (ctx) => {
      chip = ctx.toolbarButton({
        id: 'sharing-chip',
        slot: 'address',
        order: 11,
        label: 'Sharing',
        icon: () => SITE_KIND_ICONS.screenShare(),
        onClick: () => { void ctx.shell.act('sharing.bar', {}) }
      })
      chip.hidden = true
    },
    render: (state) => {
      if (chip === undefined) return
      const sharing = state.sharing ?? null
      chip.hidden = sharing === null
      if (sharing === null) return
      const label = sharingLabel(sharing)
      chip.title = label
      chip.setAttribute('aria-label', label)
    }
  }
}
