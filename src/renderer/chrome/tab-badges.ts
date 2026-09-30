import type { TabState } from '../../main/shell/tabs.js'
import { speakerIcon, speakerOffIcon } from '../pages/shared/icons.js'
import type { TabDecorator } from './context.js'

/** The host of the tab's address as the bar shows it, or the whole address when it has none (a file, a shell page). */
function hostOf (displayUrl: string): string {
  try {
    return new URL(displayUrl).host || displayUrl
  } catch {
    return displayUrl
  }
}

/** A tab's tooltip: the page's title, then where it is from, then what is true of it. The new-tab page is only "New tab". */
export function tabTooltip (tab: TabState): string {
  if (tab.isNewTab) return 'New tab'
  const state = [tab.audible && !tab.muted ? 'playing audio' : null, tab.muted ? 'muted' : null].filter((part) => part !== null)
  const where = tab.displayUrl === '' ? '' : hostOf(tab.displayUrl)
  const lines = [tab.title.length > 0 ? tab.title : where, tab.title.length > 0 ? where : '']
  if (state.length > 0) lines[1] = `${lines[1] ?? ''} (${state.join(', ')})`.trim()
  if (tab.splitWith !== null) lines.push('Split view')
  return lines.filter((line) => line !== '').join('\n')
}

/** What the speaker badge does: a tab that is muted offers to unmute, and any other to mute. */
export function muteLabel (tab: TabState): string {
  return tab.muted ? 'Unmute tab' : 'Mute tab'
}

/** Pinned look, tooltip and the sound badge of a tab. The badge is a real button between the title and the close
 * button; a pinned tab has neither, so it shows the state as a small mark on its icon. */
export const decorateTabBadges: TabDecorator = function decorateTabBadges (el, tab, state, ctx) {
  el.title = tabTooltip(tab)
  const sound = tab.audible || tab.muted
  el.classList.toggle('has-sound', sound && !tab.pinned)
  if (tab.pinned) {
    const at = state.tabs.findIndex((other) => other.id === tab.id)
    el.classList.add('pinned')
    el.classList.toggle('last-pinned', state.tabs[at + 1]?.pinned === false)
    el.setAttribute('aria-label', tab.title.length > 0 ? tab.title : 'New Tab')
    el.querySelector('.close')?.remove()
    if (sound) {
      const mark = document.createElement('span')
      mark.className = 'tab-sound-mark'
      mark.setAttribute('aria-hidden', 'true')
      mark.append(tab.muted ? speakerOffIcon() : speakerIcon())
      el.append(mark)
    }
    return
  }
  if (!sound) return
  const badge = document.createElement('button')
  badge.className = 'tab-audio no-drag'
  badge.type = 'button'
  badge.tabIndex = -1
  badge.title = muteLabel(tab)
  badge.setAttribute('aria-label', muteLabel(tab))
  badge.append(tab.muted ? speakerOffIcon() : speakerIcon())
  badge.addEventListener('click', (event) => {
    event.stopPropagation()
    void ctx.shell.act('tab.mute', { id: tab.id })
  })
  el.querySelector('.close')?.before(badge)
}
