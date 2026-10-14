import type { NetworksView } from '../../main/networks/networks-view.js'
import { closeOnEscape } from '../pages/shared/escape-closes.js'
import { createNetworkCards } from './cards.js'

// The Available networks popup's whole job: ask for the cards once, draw them, move a switch on a press, and draw
// again whenever main pushes (on every change of a node, and every two seconds for the figures). The popup is built
// fresh on every open (src/main/networks/networks-panel.ts), so nothing here outlives one open.

interface OrivonNetworks {
  view: () => Promise<NetworksView | null>
  setSwitch: (id: string, on: boolean) => Promise<boolean>
  onChange: (listener: (view: NetworksView) => void) => void
  reportHeight: (height: number) => void
  close: () => void
}

declare global {
  interface Window {
    orivonNetworks?: OrivonNetworks
  }
}

function must<T> (value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) throw new Error(message)
  return value
}

// A hard throw, unlike newtab.ts's graceful degrade: this popup's preload path is fixed at construction
// (networks-panel.ts) and never anything but preload/networks.ts, so `orivonNetworks` missing here means the preload
// itself failed, not a legitimately unprivileged load.
const networks = must(window.orivonNetworks, 'orivonNetworks not exposed -- preload did not run')

closeOnEscape(document, () => { networks.close() })

const container = must(document.querySelector<HTMLDivElement>('#cards'), '#cards missing')

/** Measured from where the content actually ENDS, not from any element's own height: `.page` is `height: 100%` of the popup, so its own heights are floored at the popup's current height and feeding either back to main gives a fixed point that can grow but never shrink. */
function reportContentHeight (): void {
  const page = document.querySelector<HTMLElement>('.page')
  if (page === null) return
  const top = page.getBoundingClientRect().top
  let bottom = top
  for (const child of page.children) {
    if (child instanceof HTMLElement && !child.hidden) bottom = Math.max(bottom, child.getBoundingClientRect().bottom)
  }
  networks.reportHeight(Math.ceil(bottom - top + parseFloat(getComputedStyle(page).paddingBottom)))
}

function show (view: NetworksView): void {
  cards.update(view)
  reportContentHeight()
}

/** A switch is read back at once, so one main refused goes back to where it was without waiting for the next push. */
const cards = createNetworkCards(container, (id, on) => {
  void networks.setSwitch(id, on).then(async () => await networks.view()).then((view) => { if (view !== null) show(view) })
})

networks.onChange(show)
void networks.view().then((view) => { if (view !== null) show(view) })
