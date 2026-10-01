// Gives each window its panel when it opens and takes it back when it closes.
import type { WindowHook } from '../shell/window-hooks.js'
import { createSidePanel } from './side-panel-host.js'
import type { PanelHost } from './side-panel-host.js'

const hosts = new WeakMap<object, { host: PanelHost, stop: () => void }>()

export const sidePanelHook: WindowHook = {
  name: 'side-panel',
  opened: (ctx) => {
    const host = createSidePanel(ctx)
    const stopSetting = ctx.services.settings.onChange(({ key }) => { if (key === 'sidePanel.side') host.sideChanged() })
    hosts.set(ctx.window, { host, stop: stopSetting })
  },
  closing: (ctx) => {
    const kept = hosts.get(ctx.window)
    if (kept === undefined) return
    kept.stop()
    kept.host.stop()
    hosts.delete(ctx.window)
  }
}
