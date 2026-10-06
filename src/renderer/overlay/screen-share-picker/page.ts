// The screen-share picker: Tab, Window and Entire screen segments of cards, an audio option, and Share. Main sends
// the whole question and every refresh of a segment's cards; the page names a card and a few options and decides
// nothing. Cards, titles and thumbnails are set as text and image data, never as markup.
import type { PickerCard, PickerSegment } from '../../../main/display-capture/picker/picker-model.js'
import type { PickerView } from '../../../main/display-capture/picker/picker-view.js'
import { h, replaceChildren } from '../../pages/shared/dom.js'
import { tabsIcon } from '../../pages/shared/icons.js'
import { SITE_KIND_ICONS } from '../../pages/shared/site-kind-icons.js'
import type { Overlay, OverlayPage } from '../kit.js'
import { COLUMNS, gridStep, isCards, isPickerView } from './view.js'
import './screen-share-picker.css'

const SEGMENT_LABEL: Readonly<Record<PickerSegment, string>> = { tab: 'Tab', window: 'Window', screen: 'Entire screen' }
const SEGMENT_NOUN: Readonly<Record<PickerSegment, string>> = { tab: 'tabs', window: 'windows', screen: 'screens' }
const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End']

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export const screenSharePickerPage: OverlayPage = {
  mount (content, overlay: Overlay) {
    const root = h('div', { className: 'picker', tabIndex: -1 })
    root.setAttribute('role', 'dialog')
    content.append(root)

    let view: PickerView | null = null
    let segment: PickerSegment = 'tab'
    let cards: Record<PickerSegment, readonly PickerCard[]> = { tab: [], window: [], screen: [] }
    let loaded: Record<PickerSegment, boolean> = { tab: true, window: false, screen: false }
    let selection: Record<PickerSegment, string | null> = { tab: null, window: null, screen: null }
    let tabAudio = true
    let systemAudio = false
    let armTimer: ReturnType<typeof setTimeout> | undefined
    let drawing = 0
    let sharing = false

    const share = h('button', { type: 'button', className: 'btn primary', textContent: 'Share', disabled: true })
    const cancel = h('button', { type: 'button', className: 'btn', textContent: 'Cancel' })
    share.addEventListener('click', doShare)
    cancel.addEventListener('click', () => { if (view !== null) void overlay.request({ type: 'cancel', id: view.id }) })
    const segmentsBar = h('div', { className: 'segmented picker-segments', role: 'tablist' })
    const panel = h('div', { className: 'picker-panel', role: 'tabpanel' })
    const audioRow = h('label', { className: 'picker-audio' })
    const audioBox = h('input', { type: 'checkbox' })
    const audioText = h('span')
    audioRow.append(audioBox, audioText)
    audioBox.addEventListener('change', () => {
      if (segment === 'tab') tabAudio = audioBox.checked
      else systemAudio = audioBox.checked
    })

    const arming = (on: boolean): void => { root.classList.toggle('arming', on) }
    // Main refuses a share inside the guard, counting from the report that the picker is drawn; the page holds Share back as long, from main's reply.
    function reportDrawn (id: string, guardMs: number): void {
      clearTimeout(armTimer)
      arming(true)
      const mine = ++drawing
      const settle = (): void => { if (mine === drawing) armTimer = setTimeout(() => { arming(false) }, guardMs) }
      void overlay.request({ type: 'drawn', id }).then(settle, settle)
    }
    overlay.onEvent((event) => {
      if (!isRecord(event) || view === null) return
      if (event['type'] === 'arm') {
        clearTimeout(armTimer)
        arming(true)
        armTimer = setTimeout(() => { arming(false) }, view.guardMs)
      } else if (event['type'] === 'cards' && typeof event['segment'] === 'string' && isCards(event['cards'])) {
        const which = event['segment'] as PickerSegment
        if (!(which in cards)) return
        cards = { ...cards, [which]: event['cards'] as PickerCard[] }
        loaded = { ...loaded, [which]: true }
        if (selection[which] !== null && !cards[which].some((card) => card.id === selection[which])) selection = { ...selection, [which]: null }
        if (which === segment) drawPanel()
      }
    })

    const modeOf = (which: PickerSegment): 'list' | 'portal' | 'permission' => which === 'tab' || view === null ? 'list' : view.modes[which]

    function doShare (): void {
      const card = selection[segment]
      if (view === null || card === null || sharing || root.classList.contains('arming')) return
      const audio = segment === 'tab' ? view.audio.tab && tabAudio : segment === 'screen' ? view.audio.system && systemAudio : false
      sharing = true
      share.disabled = true
      void overlay.request({ type: 'share', id: view.id, card, audio }).finally(() => { sharing = false; refreshShare() })
    }

    function refreshShare (): void {
      share.disabled = selection[segment] === null || modeOf(segment) === 'permission' || sharing
    }

    function select (id: string | null): void {
      selection = { ...selection, [segment]: id }
      for (const li of panel.querySelectorAll<HTMLElement>('[role="option"]')) li.setAttribute('aria-selected', String(li.dataset['card'] === id))
      const grid = panel.querySelector('.picker-grid')
      const chosen = id === null ? null : panel.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
      if (chosen === null) grid?.removeAttribute('aria-activedescendant')
      else { grid?.setAttribute('aria-activedescendant', chosen.id); chosen.scrollIntoView({ block: 'nearest' }) }
      refreshShare()
    }

    function cardElement (card: PickerCard, index: number): HTMLElement {
      const picture = card.thumb !== null
        ? h('img', { className: 'picker-thumb', alt: '', src: card.thumb, draggable: false })
        : h('span', { className: 'picker-thumb picker-thumb-empty' }, card.icon !== null ? h('img', { className: 'picker-icon', alt: '', src: card.icon, draggable: false }) : segment === 'tab' ? tabsIcon() : SITE_KIND_ICONS.screenShare())
      const li = h('li', { className: 'picker-card', role: 'option', id: `picker-card-${String(index)}` },
        picture,
        h('span', { className: 'picker-label', title: card.label }, card.label),
        card.self ? h('span', { className: 'badge picker-self' }, 'This tab') : card.sub !== null ? h('span', { className: 'picker-sub', title: card.sub }, card.sub) : null)
      li.dataset['card'] = card.id
      li.setAttribute('aria-selected', String(selection[segment] === card.id))
      li.addEventListener('click', () => { select(card.id) })
      li.addEventListener('dblclick', () => { select(card.id); doShare() })
      return li
    }

    function drawPanel (): void {
      if (view === null) return
      const list = cards[segment]
      const mode = modeOf(segment)
      if (mode === 'permission') {
        replaceChildren(panel,
          h('div', { className: 'picker-notice', role: 'status' },
            h('p', null, view.permissionText),
            h('button', { type: 'button', className: 'btn', textContent: 'Open System Settings', onclick: () => { void overlay.request({ type: 'open-settings', id: view?.id ?? '' }) } })))
      } else if (list.length === 0) {
        replaceChildren(panel, h('p', { className: 'picker-empty', role: 'status' }, loaded[segment] ? `No ${SEGMENT_NOUN[segment]} to share.` : `Looking for ${SEGMENT_NOUN[segment]}...`))
      } else {
        const grid = h('ul', { className: 'picker-grid', role: 'listbox', tabIndex: 0 }, ...list.map(cardElement))
        grid.setAttribute('aria-label', labelOf(segment))
        grid.style.setProperty('--picker-columns', String(COLUMNS))
        replaceChildren(panel, grid)
        const chosen = selection[segment]
        if (chosen !== null) select(chosen)
      }
      drawAudio()
      refreshShare()
    }

    function drawAudio (): void {
      if (view === null) return
      const forTab = segment === 'tab' && view.audio.tab
      const forScreen = segment === 'screen' && view.audio.system
      audioRow.hidden = !(forTab || forScreen)
      audioText.textContent = forTab ? 'Also share tab audio' : 'Also share system audio'
      audioBox.checked = forTab ? tabAudio : systemAudio
    }

    /** Where the system's dialog chooses and no window segment is offered, the screen segment's dialog lists windows too. */
    function labelOf (which: PickerSegment): string {
      return which === 'screen' && view !== null && view.modes.screen === 'portal' && !view.segments.includes('window') ? 'Window or screen' : SEGMENT_LABEL[which]
    }

    function drawSegments (): void {
      if (view === null) return
      const buttons = view.segments.map((which) => {
        const button = h('button', { type: 'button', textContent: labelOf(which), onclick: () => { switchTo(which) } })
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-selected', String(which === segment))
        button.setAttribute('aria-pressed', String(which === segment))
        button.dataset['segment'] = which
        button.tabIndex = which === segment ? 0 : -1
        return button
      })
      replaceChildren(segmentsBar, ...buttons)
    }

    function switchTo (which: PickerSegment): void {
      if (view === null || which === segment) return
      segment = which
      drawSegments()
      drawPanel()
      void overlay.request({ type: 'segment', id: view.id, segment: which })
    }

    root.addEventListener('keydown', (event) => {
      if (view === null) return
      const target = event.target as HTMLElement
      if (target.closest('.picker-segments') !== null && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        const at = view.segments.indexOf(segment)
        const next = view.segments[event.key === 'ArrowLeft' ? Math.max(0, at - 1) : Math.min(view.segments.length - 1, at + 1)]
        if (next === undefined) return
        event.preventDefault()
        switchTo(next)
        segmentsBar.querySelector<HTMLElement>(`[data-segment="${next}"]`)?.focus()
        return
      }
      if (target !== root && !target.classList.contains('picker-grid')) return
      if (ARROWS.includes(event.key)) {
        const list = cards[segment]
        const at = list.findIndex((card) => card.id === selection[segment])
        const to = gridStep(list.length, at < 0 ? null : at, event.key)
        event.preventDefault()
        select(to === null ? null : list[to]?.id ?? null)
      } else if (event.key === 'Enter') {
        event.preventDefault()
        doShare()
      }
    })

    return {
      shown (payload) {
        if (!isPickerView(payload)) { overlay.close(); return }
        view = payload
        segment = payload.segment
        cards = { ...payload.cards }
        loaded = { tab: true, window: payload.cards.window.length > 0 || payload.modes.window !== 'list', screen: payload.cards.screen.length > 0 || payload.modes.screen !== 'list' }
        selection = { tab: null, window: null, screen: null }
        const preselected = payload.selected
        if (preselected !== null) for (const which of payload.segments) if (cards[which].some((card) => card.id === preselected)) selection[which] = preselected
        tabAudio = true
        systemAudio = payload.audio.systemDefault
        sharing = false
        root.setAttribute('aria-labelledby', 'picker-title')
        replaceChildren(root,
          h('h1', { className: 'sheet-title', id: 'picker-title' }, payload.title),
          segmentsBar,
          panel,
          audioRow,
          h('div', { className: 'btn-row' }, cancel, share))
        drawSegments()
        drawPanel()
        root.focus()
        reportDrawn(payload.id, payload.guardMs)
      }
    }
  }
}
