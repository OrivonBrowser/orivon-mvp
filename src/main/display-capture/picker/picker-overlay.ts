// The screen-share picker: a centred sheet with Tab, Window and Entire screen segments of cards. Main holds every
// source behind a random card id and resolves the question with a choice or null; the page names a card and a few
// options and decides nothing. Share is guarded like a site prompt's answer: it needs the picker drawn for a moment
// and a quiet keyboard.
import { formatOriginForDisplay } from '../../consent/grant-prompt-origin.js'
import { createKeyQuiet } from '../../overlays/key-quiet.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../../overlays/overlay-types.js'
import { slotClosed } from '../../overlays/tab-slots.js'
import type { DisplayChoice } from '../types.js'
import { audioPlan, budgetImages, cardText, defaultSegment, portalCardText, PERMISSION_TEXT, segmentMode, segmentsFor, SCREEN_SETTINGS_URL } from './picker-model.js'
import type { PickerCard, PickerPlatform, PickerSegment } from './picker-model.js'
import { createSourceFeed, sourceCard } from './picker-sources.js'
import type { FeedTimers, RawSource, SourceFeed } from './picker-sources.js'
import type { PickerStore, Question } from './picker-store.js'
import { offeredTabs } from './picker-tabs.js'
import type { TabOffer } from './picker-tabs.js'
import { asPickerCommand, asPickerId } from './picker-view.js'
import type { PickerEvent, PickerView } from './picker-view.js'

export const PICKER_OVERLAY = 'screen-share-picker'
const PICKER_WIDTH = 640
/** A share is ignored this long after the picker is drawn, so a click or key meant for the page cannot land on it. */
export const SHARE_GUARD_MS = 500
export const THUMB_SIZE = { width: 320, height: 180 }

export interface DesktopListing {
  readonly types: Array<'window' | 'screen'>
  readonly thumbnailSize: { readonly width: number, readonly height: number }
  readonly fetchWindowIcons: boolean
}

export interface PickerDeps {
  readonly store: PickerStore
  readonly platform: () => PickerPlatform
  /** `desktopCapturer.getSources`. */
  readonly getSources: (listing: DesktopListing) => Promise<readonly RawSource[]>
  /** A tab's page as a JPEG data URL, or null when it cannot be captured. */
  readonly captureTab: (tab: Electron.WebContents) => Promise<string | null>
  readonly openSettings: (url: string) => void
  readonly now?: () => number
  readonly timers?: FeedTimers
}

/** Tabs captured for a thumbnail in one show: a page behind the one in front gives none, so this only bounds the work. */
const MAX_TAB_CAPTURES = 12

export function createPicker (deps: PickerDeps, { window, services, close, send }: OverlayWindow): OverlayHandler {
  const now = deps.now ?? Date.now
  const keys = createKeyQuiet(now)
  let question: Question | null = null
  let shownAt: number | null = null
  let segment: PickerSegment = 'tab'
  /** A share waits on the system's dialog: nothing else is accepted meanwhile. */
  let busy = false
  let feed: SourceFeed | null = null
  const thumbs = new Map<Electron.WebContents, string | null>()

  const push = (event: PickerEvent): void => { send(event) }
  const current = (id: string): Question | undefined => {
    const asked = deps.store.get(id)
    return asked !== undefined && asked === question && !asked.settled && asked.owner === window && window.tabs.getState().activeTabId === asked.tabId ? asked : undefined
  }

  function tabCards (asked: Question): { cards: PickerCard[], offers: TabOffer[] } {
    const offers = offeredTabs(services.windows.all(), asked.request)
    const live = new Set<string>()
    const cards = offers.map((offer): PickerCard => {
      const id = deps.store.cardId(asked, `tab:${String(offer.wc.id)}`, { kind: 'tab', tab: offer.wc })
      live.add(id)
      const host = offer.tab.displayUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/.*$/, '')
      return { id, label: cardText(offer.tab.title) || cardText(host) || 'Untitled', sub: cardText(host) || null, thumb: thumbs.get(offer.wc) ?? null, icon: offer.tab.favicon, self: offer.self }
    })
    for (const [id, ref] of asked.refs) if (ref.kind === 'tab' && !live.has(id)) asked.refs.delete(id)
    return { cards: budgetImages(cards), offers }
  }

  /** Captures what the tabs show for thumbnails, then offers the list again with them. */
  function captureThumbnails (asked: Question, offers: readonly TabOffer[]): void {
    const wanted = offers.filter((offer) => !thumbs.has(offer.wc)).slice(0, MAX_TAB_CAPTURES)
    if (wanted.length === 0) return
    void Promise.all(wanted.map(async (offer) => { thumbs.set(offer.wc, await deps.captureTab(offer.wc).catch(() => null)) })).then(() => {
      if (asked === question && !asked.settled) push({ type: 'cards', segment: 'tab', cards: tabCards(asked).cards })
    })
  }

  function deliver (type: 'window' | 'screen', sources: readonly RawSource[]): void {
    const asked = question
    if (asked === null || asked.settled || segment !== type) return
    const seen = new Set<string>()
    const cards = sources.map((source) => {
      const id = deps.store.cardId(asked, `source:${source.id}`, { kind: type, source: { id: source.id, name: source.name } })
      seen.add(id)
      return sourceCard(source, id)
    })
    for (const [id, ref] of asked.refs) if (ref.kind === type && !seen.has(id)) asked.refs.delete(id)
    push({ type: 'cards', segment: type, cards: budgetImages(cards) })
  }

  function portalCard (asked: Question, which: 'window' | 'screen'): PickerCard {
    const text = portalCardText(which)
    return { id: deps.store.cardId(asked, `portal:${which}`, { kind: 'portal', segment: which }), label: text.label, sub: text.sub, thumb: null, icon: null, self: false }
  }

  /** What the segment in view needs from the system: nothing for tabs, a refreshed listing for windows and screens. */
  function enter (next: PickerSegment): void {
    segment = next
    if (next === 'tab') {
      feed?.stop()
      return
    }
    if (segmentMode(deps.platform()) === 'list') feed?.watch(next)
    else feed?.stop()
  }

  function finish (asked: Question, choice: DisplayChoice | null): void {
    deps.store.settle(asked.id, choice)
    close()
  }

  /** Wayland: the system's own dialog lists and picks, and answers with the one source. */
  function shareFromPortal (asked: Question, which: 'window' | 'screen', systemAudio: boolean): void {
    busy = true
    void deps.getSources({ types: [which], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false }).then(
      (sources): DisplayChoice | null => {
        const [source, ...others] = sources
        return source === undefined || others.length > 0 ? null : { kind: which, source: { id: source.id, name: source.name }, systemAudio, label: cardText(source.name) || 'Shared window' }
      },
      (): null => null
    ).then((choice) => {
      busy = false
      if (asked === question && !asked.settled) finish(asked, choice)
    })
  }

  function share (asked: Question, cardId: string, wantsAudio: boolean): void {
    const ref = asked.refs.get(cardId)
    if (ref === undefined) return
    const audio = audioPlan(asked.request.audio, asked.request.hints, deps.platform())
    if (ref.kind === 'tab') {
      const offer = offeredTabs(services.windows.all(), asked.request).find((candidate) => candidate.wc === ref.tab)
      if (offer === undefined) {
        push({ type: 'cards', segment: 'tab', cards: tabCards(asked).cards })
        return
      }
      finish(asked, { kind: 'tab', tab: offer.wc, audio: audio.tab && wantsAudio, label: cardText(offer.tab.title) || 'Tab' })
    } else if (ref.kind === 'portal') {
      shareFromPortal(asked, ref.segment, ref.segment === 'screen' && audio.system && wantsAudio)
    } else {
      finish(asked, { kind: ref.kind, source: ref.source, systemAudio: ref.kind === 'screen' && audio.system && wantsAudio, label: cardText(ref.source.name) || 'Shared window' })
    }
  }

  function stop (): void {
    feed?.stop()
    feed = null
    question = null
    shownAt = null
    busy = false
    thumbs.clear()
    keys.reset()
  }

  return {
    key: keys.onKey,
    show: (payload): PickerView | undefined => {
      stop()
      const id = asPickerId(payload)
      const asked = id === undefined ? undefined : deps.store.get(id)
      if (asked === undefined || asked.settled || asked.owner !== window || window.tabs.getState().activeTabId !== asked.tabId) return undefined
      question = asked
      const platform = deps.platform()
      const mode = segmentMode(platform)
      const segments = segmentsFor(asked.request.hints)
      const first = defaultSegment(asked.request.hints, segments)
      const { cards: tabs, offers } = tabCards(asked)
      const other = (which: 'window' | 'screen'): PickerCard[] => mode === 'portal' ? [portalCard(asked, which)] : []
      feed = createSourceFeed(
        async (type) => await deps.getSources({ types: [type], thumbnailSize: THUMB_SIZE, fetchWindowIcons: type === 'window' }),
        deliver,
        deps.timers
      )
      enter(first)
      captureThumbnails(asked, offers)
      return {
        id: asked.id,
        title: `Choose what to share with ${formatOriginForDisplay(asked.request.origin)}`,
        segments,
        segment: first,
        cards: { tab: tabs, window: other('window'), screen: other('screen') },
        modes: { window: mode, screen: mode },
        permissionText: PERMISSION_TEXT,
        audio: audioPlan(asked.request.audio, asked.request.hints, platform),
        selected: asked.request.hints.preferCurrentTab === true ? tabs.find((card) => card.self)?.id ?? null : null,
        guardMs: SHARE_GUARD_MS
      }
    },

    request: (command) => {
      const asked = asPickerCommand(command)
      if (asked === undefined) return undefined
      const open = current(asked.id)
      if (open === undefined) return undefined
      if (asked.type === 'drawn') {
        if (shownAt === null) shownAt = now()
        return true
      }
      if (busy) return undefined
      if (asked.type === 'cancel') {
        finish(open, null)
      } else if (asked.type === 'segment') {
        if (segmentsFor(open.request.hints).includes(asked.segment)) enter(asked.segment)
      } else if (asked.type === 'open-settings') {
        if (segmentMode(deps.platform()) === 'permission') deps.openSettings(SCREEN_SETTINGS_URL)
      } else if (asked.type === 'share' && shownAt !== null && now() - shownAt >= SHARE_GUARD_MS && keys.quietFor() >= SHARE_GUARD_MS) {
        share(open, asked.card, asked.audio)
      }
      return undefined
    },

    // A resize moves the picker under the person's pointer: the guard starts over.
    moved: () => {
      if (question === null || shownAt === null) return
      shownAt = now()
      push({ type: 'arm' })
    },

    closed: (reason) => {
      stop()
      slotClosed(window, PICKER_OVERLAY, reason)
    },

    disposed: stop
  }
}

export function pickerOverlayFor (deps: PickerDeps): OverlayDef {
  return {
    name: PICKER_OVERLAY,
    placement: { kind: 'area', at: 'center', width: PICKER_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'bar',
    // A tab switch only hides the picker (the slot keeps it for the tab); any other way out ends it as a cancel.
    closeOn: { blur: false, tabSwitch: true, navigation: true, layout: false },
    keep: 'fresh',
    height: { initial: 420, min: 260, max: 540 },
    attach: (win) => createPicker(deps, win)
  }
}
