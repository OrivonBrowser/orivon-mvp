// The reload button becomes Stop while the active tab loads. The swap to Stop
// waits a moment so a page that loads at once never flashes it; the swap back
// is immediate. Navigation owns the button's Reload click, and this module
// answers the click first while the button is Stop.
import { closeIcon } from '../pages/shared/icons.js'
import type { ChromeContext, ChromeModule } from './context.js'
import { must } from './context.js'

/** A load shorter than this never shows Stop. */
export const STOP_DELAY_MS = 150

export interface StopSwitch {
  /** Reports whether the active tab is loading now. */
  update: (loading: boolean) => void
  stopping: () => boolean
}

/** The mode of the button: Stop only after `delay` ms of continuous loading, Reload again as soon as loading ends. `apply` draws the mode. */
export function createStopSwitch (apply: (stop: boolean) => void, delay = STOP_DELAY_MS): StopSwitch {
  let stop = false
  let waiting: ReturnType<typeof setTimeout> | undefined
  let loadingNow = false
  const settle = (value: boolean): void => {
    if (stop === value) return
    stop = value
    apply(stop)
  }
  return {
    stopping: () => stop,
    update (loading) {
      loadingNow = loading
      if (!loading) {
        if (waiting !== undefined) { clearTimeout(waiting); waiting = undefined }
        settle(false)
      } else if (!stop && waiting === undefined) {
        waiting = setTimeout(() => {
          waiting = undefined
          if (loadingNow) settle(true)
        }, delay)
      }
    }
  }
}

export function createReloadStop (): ChromeModule {
  let mode: StopSwitch | undefined
  return {
    name: 'reload-stop',
    init: (ctx: ChromeContext) => {
      const button = must(document.querySelector<HTMLButtonElement>('#reload'), '#reload missing')
      const reloadIcon = must(button.querySelector('svg'), '#reload has no icon')
      let current: Element = reloadIcon
      mode = createStopSwitch((stop) => {
        const next = stop ? closeIcon() : reloadIcon
        current.replaceWith(next)
        current = next
        button.setAttribute('aria-label', stop ? 'Stop loading' : 'Reload')
        if (stop) button.title = 'Stop loading (Esc)'
        else button.removeAttribute('title')
      })
      button.addEventListener('click', (event) => {
        if (mode?.stopping() !== true) return
        event.stopImmediatePropagation()
        ctx.shell.runCommand('nav.stop')
      }, true)
    },
    render: (_state, ctx) => { mode?.update(ctx.activeTab()?.loading === true) }
  }
}
