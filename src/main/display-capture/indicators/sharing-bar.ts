// The bar at the top of a window while one of its pages is sharing: who is sharing what, with Stop sharing and Hide.
// It belongs to the window, not to a tab, so it stays through tab switches and navigations and goes away when the
// window has no share left. Hide keeps it away until a new share starts or the sharing chip is clicked.
import type { OverlayDef, OverlayHandler } from '../../overlays/overlay-types.js'
import type { ShellWindow } from '../../shell/window-registry.js'
import { shareRegistry } from '../bindings.js'
import type { ActiveShare, ShareRegistry } from '../types.js'
import { barText, sharesOfWindow } from './shares.js'

export const SHARING_BAR_OVERLAY = 'sharing-bar'
const BAR_WIDTH = 560
const BAR_HEIGHT = 44

export interface SharingBarView {
  readonly text: string
  readonly count: number
}

interface WindowState { hidden: boolean, seen: Set<string> }

export class SharingBars {
  private readonly states = new WeakMap<ShellWindow, WindowState>()
  private windows: () => readonly ShellWindow[] = () => []
  private registry: () => ShareRegistry = shareRegistry

  /** The windows to look after, and where the shares are read from (the bound registry unless a test says otherwise). */
  use (windows: () => readonly ShellWindow[], registry: () => ShareRegistry = shareRegistry): void {
    this.windows = windows
    this.registry = registry
  }

  /** The running shares whose page is in `window`. */
  sharesIn (window: ShellWindow): ActiveShare[] {
    return sharesOfWindow(this.registry().list(), (contents) => window.tabs.findTabIdByWebContents(contents) !== null)
  }

  viewFor (window: ShellWindow): SharingBarView | null {
    const shares = this.sharesIn(window)
    return shares.length === 0 ? null : { text: barText(shares), count: shares.length }
  }

  /** Brings every window's bar in line with the running shares. */
  sync (): void {
    for (const window of this.windows()) this.syncWindow(window)
  }

  /** The sharing chip was clicked: the bar shows again if it was hidden. */
  reveal (window: ShellWindow): void {
    this.stateOf(window).hidden = false
    this.syncWindow(window)
  }

  hide (window: ShellWindow): void {
    this.stateOf(window).hidden = true
    this.syncWindow(window)
  }

  /** Stop sharing: every share of this window ends. */
  stopAll (window: ShellWindow): void {
    for (const share of this.sharesIn(window)) this.registry().stop(share.id)
  }

  private stateOf (window: ShellWindow): WindowState {
    let state = this.states.get(window)
    if (state === undefined) this.states.set(window, state = { hidden: false, seen: new Set() })
    return state
  }

  private syncWindow (window: ShellWindow): void {
    if (window.window.isDestroyed()) return
    const state = this.stateOf(window)
    const shares = this.sharesIn(window)
    if (shares.some((share) => !state.seen.has(share.id))) state.hidden = false
    state.seen = new Set(shares.map((share) => share.id))
    const wanted = shares.length > 0 && !state.hidden
    const open = window.overlays.isOpen(SHARING_BAR_OVERLAY)
    if (wanted && !open) window.overlays.show(SHARING_BAR_OVERLAY)
    else if (wanted) window.overlays.send(SHARING_BAR_OVERLAY, { type: 'view', view: this.viewFor(window) })
    else if (open) window.overlays.close(SHARING_BAR_OVERLAY)
  }
}

export const sharingBars = new SharingBars()

type Command = 'stop' | 'hide'

/** Only `{ type: 'stop' }` and `{ type: 'hide' }`, with no extra keys. */
function asCommand (command: unknown): Command | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, ...rest } = command as Record<string, unknown>
  return Object.keys(rest).length === 0 && (type === 'stop' || type === 'hide') ? type : undefined
}

export function sharingBarOverlayFor (bars: SharingBars): OverlayDef {
  return {
    name: SHARING_BAR_OVERLAY,
    placement: { kind: 'area', at: 'top-center', width: BAR_WIDTH },
    surface: 'panel',
    focus: 'never',
    layer: 'bar',
    // About the window's shares, not about a tab: switching tabs or pages leaves it, and so does a resize.
    closeOn: { blur: false, tabSwitch: false, navigation: false, layout: false },
    keep: 'fresh',
    height: { initial: BAR_HEIGHT, min: BAR_HEIGHT, max: BAR_HEIGHT },
    attach: ({ window }): OverlayHandler => ({
      show: () => bars.viewFor(window) ?? undefined,
      request: (command) => {
        const asked = asCommand(command)
        if (asked === 'stop') bars.stopAll(window)
        else if (asked === 'hide') bars.hide(window)
        return undefined
      }
    })
  }
}

export const sharingBarOverlay = sharingBarOverlayFor(sharingBars)
