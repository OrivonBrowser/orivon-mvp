import type { TabState } from '../../main/shell/tabs.js'
import { eyeIcon, speakerIcon, speakerOffIcon } from '../pages/shared/icons.js'
import { SITE_KIND_ICONS } from '../pages/shared/site-kind-icons.js'
import type { TabDecorator } from './context.js'

/** The host of the tab's address as the bar shows it, or the whole address when it has none (a file, a shell page). */
function hostOf (displayUrl: string): string {
  try {
    return new URL(displayUrl).host || displayUrl
  } catch {
    return displayUrl
  }
}

const SHARING_LABEL: Readonly<Record<NonNullable<TabState['sharing']>, string>> = {
  screen: 'Sharing your screen',
  window: 'Sharing a window',
  tab: 'Sharing a tab'
}

/** What a tab says about a screen share it is part of, or null: the page that shares, or the tab being shown. */
export function sharingLabel (tab: TabState): string | null {
  if (tab.sharing !== undefined) return SHARING_LABEL[tab.sharing]
  return tab.shared === true ? 'This tab is being shared' : null
}

/** A tab's tooltip: the page's title, then where it is from, then what is true of it. The new-tab page is only "New tab". */
export function tabTooltip (tab: TabState): string {
  if (tab.isNewTab) return 'New tab'
  const silenced = tab.muted || tab.siteMuted === true
  const state = [tab.audible && !silenced ? 'playing audio' : null, tab.siteMuted === true ? 'muted by site settings' : tab.muted ? 'muted' : null].filter((part) => part !== null)
  const where = tab.displayUrl === '' ? '' : hostOf(tab.displayUrl)
  const lines = [tab.title.length > 0 ? tab.title : where, tab.title.length > 0 ? where : '']
  if (state.length > 0) lines[1] = `${lines[1] ?? ''} (${state.join(', ')})`.trim()
  if (tab.splitWith !== null) lines.push('Split view')
  const sharing = sharingLabel(tab)
  if (sharing !== null) lines.push(sharing)
  return lines.filter((line) => line !== '').join('\n')
}

/** A tab's accessible name: its title, and whether it is playing or muted, which the icon and mark show only to sight. */
export function tabName (tab: TabState): string {
  const title = tab.title.length > 0 ? tab.title : 'New tab'
  const sharing = sharingLabel(tab)
  return `${title}${tab.siteMuted === true ? ', muted by site settings' : tab.muted ? ', muted' : tab.audible ? ', playing audio' : ''}${sharing === null ? '' : `, ${sharing.toLowerCase()}`}`
}

/** What the speaker badge does: a tab that is muted offers to unmute, and any other to mute. */
export function muteLabel (tab: TabState): string {
  if (tab.siteMuted === true) return 'Muted by site settings'
  return tab.muted ? 'Unmute tab' : 'Mute tab'
}

/** The mark for a tab in a share: a red screen for the page that shares, an eye for the tab being shown. Not a button: the way to stop is the bar and the chip. */
function shareMark (tab: TabState, label: string, className: string): HTMLElement {
  const mark = document.createElement('span')
  mark.className = `${className} ${tab.sharing !== undefined ? 'sharing' : 'shared'}`
  mark.title = label
  mark.setAttribute('role', 'img')
  mark.setAttribute('aria-label', label)
  mark.append(tab.sharing !== undefined ? SITE_KIND_ICONS.screenShare() : eyeIcon())
  return mark
}

/** Pinned look, tooltip and the sound badge of a tab. The badge is a real button between the title and the close
 * button; a pinned tab has neither, so it shows the state as a small mark on its icon. */
export const decorateTabBadges: TabDecorator = function decorateTabBadges (el, tab, state, ctx) {
  el.title = tabTooltip(tab)
  el.setAttribute('aria-label', tabName(tab))
  const silenced = tab.muted || tab.siteMuted === true
  const sound = tab.audible || silenced
  el.classList.toggle('has-sound', sound && !tab.pinned)
  const sharing = sharingLabel(tab)
  if (tab.pinned) {
    const at = state.tabs.findIndex((other) => other.id === tab.id)
    el.classList.add('pinned')
    el.classList.toggle('last-pinned', state.tabs[at + 1]?.pinned === false)
    el.querySelector('.close')?.remove()
    if (sound) {
      const mark = document.createElement('span')
      mark.className = 'tab-sound-mark'
      mark.setAttribute('aria-hidden', 'true')
      mark.append(silenced ? speakerOffIcon() : speakerIcon())
      el.append(mark)
    }
    if (sharing !== null) el.append(shareMark(tab, sharing, 'tab-share-mark'))
    return
  }
  if (sharing !== null) el.querySelector('.close')?.before(shareMark(tab, sharing, 'tab-share'))
  if (!sound) return
  const badge = document.createElement('button')
  badge.className = 'tab-audio no-drag'
  badge.type = 'button'
  badge.tabIndex = -1
  badge.title = muteLabel(tab)
  badge.setAttribute('aria-label', muteLabel(tab))
  badge.append(silenced ? speakerOffIcon() : speakerIcon())
  // The tab's own mute never overrides its site's: the badge reports it and does nothing.
  if (tab.siteMuted === true) badge.setAttribute('aria-disabled', 'true')
  badge.addEventListener('click', (event) => {
    event.stopPropagation()
    if (tab.siteMuted !== true) void ctx.shell.act('tab.mute', { id: tab.id })
  })
  el.querySelector('.close')?.before(badge)
}
