// Puts zoom on every page the process makes, tabs included whichever way they
// came to exist (a repartitioned view, a popup adopted as a tab, a page moved
// between windows), without wiring each one.
import type { App } from 'electron'
import type { WindowRegistry } from '../shell/window-registry.js'
import { attachZoom } from './attach-zoom.js'
import type { ZoomService } from './zoom-service.js'

export function installZoom (app: Pick<App, 'on'>, windows: WindowRegistry, zoom: ZoomService): void {
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') attachZoom(contents, zoom, { isTab: (candidate) => windows.findTab(candidate) !== null })
  })
}
