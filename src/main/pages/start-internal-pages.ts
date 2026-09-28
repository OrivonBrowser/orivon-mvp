// Brings the shell's own pages to life once the shared services exist: the
// channel they speak on, and the changes they hear about while open.
import { app, session } from 'electron'
import { devModeEnabled } from '../dev/dev-mode.js'
import type { ShellServices } from '../shell/shell-services.js'
import { settingsDomain } from '../settings/settings-domain.js'
import { shortcutsDomain } from '../shortcuts/shortcuts-domain.js'
import { pagesDomain } from './pages-domain.js'
import { historyDomain } from '../history/history-domain.js'
import { privacyDomain } from '../privacy/privacy-domain.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { createPermissionsController } from '../permissions/permissions.js'
import type { SubsystemContext } from '../registry.js'
import type { InternalDomain } from './internal-ipc.js'
import { registerInternalIpc } from './internal-ipc.js'
import { internalSession } from './internal-session.js'

/** Facts about this build, for the About section. */
function aboutDomain (): InternalDomain {
  return {
    pages: ['settings'],
    handle: () => ({
      version: app.getVersion(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
      userAgent: session.defaultSession.getUserAgent(),
      developerMode: devModeEnabled()
    })
  }
}

/** Once per process. */
export function startInternalPages (services: ShellServices, ctx: SubsystemContext): void {
  const permissions = createPermissionsController(ctx)
  registerInternalIpc(services.internalPages, internalSession, {
    settings: settingsDomain(services.settings),
    shortcuts: shortcutsDomain(services.shortcuts),
    history: historyDomain(services.history),
    pages: pagesDomain(services.windows),
    privacy: privacyDomain(services.history, services.zoomStore, {
      history: services.history,
      zoom: services.zoomStore,
      websites: session.defaultSession,
      appSessions: async () => (await permissions.list()).map((app) => session.fromPartition(partitionFor(app.origin))),
      now: Date.now
    }),
    about: aboutDomain()
  })
  services.settings.onChange((change) => { services.internalPages.publish('settings.changed', change, ['settings']) })
  services.shortcuts.onChange(() => { services.internalPages.publish('shortcuts.changed', services.shortcuts.rows(), ['settings']) })
}
