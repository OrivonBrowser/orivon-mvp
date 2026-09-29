// Brings the shell's own pages to life once the shared services exist: the
// channel they speak on, and the changes they hear about while open.
import { app, session } from 'electron'
import { devModeEnabled } from '../dev/dev-mode.js'
import type { ShellServices } from '../shell/shell-services.js'
import { extensionsDomain } from '../extensions/extensions-domain.js'
import { readExtensionFacts } from '../extensions/extensions-view-runner.js'
import { pickExtensionFile, pickExtensionFolder } from '../extensions/extensions-picker-runner.js'
import { settingsDomain } from '../settings/settings-domain.js'
import { shortcutsDomain } from '../shortcuts/shortcuts-domain.js'
import { pagesDomain } from './pages-domain.js'
import { appsDomain } from '../permissions/apps-domain.js'
import { identityKeyStorage } from '../keyring/electron-keychain.js'
import { onVerifierChange, verifierView } from '../verifier/verifier-subsystem.js'
import { web3Domain } from '../verifier/web3-domain.js'
import { appDomain } from './app-domain.js'
import { telemetryDomain } from './telemetry-domain.js'
import { checkUpdateNow } from '../self-update/update-check-runner.js'
import { updatesDomain } from '../self-update/updates-domain.js'
import { profilesDomain } from '../launch/profiles-domain.js'
import { historyDomain } from '../history/history-domain.js'
import { privacyDomain } from '../privacy/privacy-domain.js'
import { partitionFor } from '../../broker/grants/origin-hash.js'
import { isOriginServedFromCacheSync } from '../../loader/electron/serve.js'
import { createPermissionsController } from '../permissions/permissions.js'
import type { SubsystemContext } from '../registry.js'
import type { InternalDomain } from './internal-ipc.js'
import { registerInternalIpc } from './internal-ipc.js'
import { cleanOrphanedAppPartitions } from './orphaned-app-partitions.js'
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
  if (ctx.extensions === undefined) {
    throw new Error('startInternalPages requires ctx.extensions -- check extensionsSubsystem\'s position in subsystems.ts')
  }
  const extensions = ctx.extensions
  registerInternalIpc(services.internalPages, internalSession, {
    settings: settingsDomain(services.settings),
    shortcuts: shortcutsDomain(services.shortcuts),
    history: historyDomain(services.history),
    profiles: profilesDomain(services.profiles),
    pages: pagesDomain(services.windows),
    extensions: extensionsDomain({
      extensions,
      readFacts: readExtensionFacts,
      developerModeEnabled: () => services.settings.get('extensions.developerMode'),
      pickFolder: pickExtensionFolder,
      pickFile: pickExtensionFile,
      notify: () => { services.internalPages.publish('extensions.changed', undefined, ['extensions']) }
    }),
    privacy: privacyDomain(services.history, services.zoomStore, {
      history: services.history,
      zoom: services.zoomStore,
      websites: session.defaultSession,
      // Only a CACHE-SERVED app still has a partition of its own to clear:
      // a granted-without-install app shares session.defaultSession, which
      // `websites` above already reaches. Calling session.fromPartition on
      // the others would only mint a fresh, never-used, empty partition for
      // each -- ADR-0018's own warning against probing session.fromPartition
      // speculatively.
      appSessions: async () => (await permissions.list())
        .filter((app) => isOriginServedFromCacheSync(app.origin))
        .map((app) => session.fromPartition(partitionFor(app.origin))),
      now: Date.now
    }),
    apps: appsDomain({ permissions, userDataPath: app.getPath('userData'), identity: identityKeyStorage }),
    web3: web3Domain({
      view: verifierView,
      enabled: () => services.settings.get('web3.lightClient'),
      enabledAtStart: services.settings.get('web3.lightClient'),
      forcedOff: () => process.env['ORIVON_ETH_LIGHT_CLIENT'] === 'off'
    }),
    app: appDomain(app, services.profiles.isPrivate),
    telemetry: telemetryDomain(app, services.profiles.isPrivate),
    updates: updatesDomain(async () => await checkUpdateNow(app), services.profiles.isPrivate),
    about: aboutDomain()
  })
  onVerifierChange(() => { services.internalPages.publish('web3.changed', verifierView(), ['settings']) })
  // Reaches 'extensions' too: it reads and writes 'extensions.developerMode' through this same domain.
  services.settings.onChange((change) => { services.internalPages.publish('settings.changed', change, ['settings', 'extensions']) })
  services.shortcuts.onChange(() => { services.internalPages.publish('shortcuts.changed', services.shortcuts.rows(), ['settings']) })
  // Fire-and-forget, like the update check below it in index.ts: a one-time
  // cleanup, never the window's own critical path. orphaned-app-partitions.ts's
  // own header has the full reasoning.
  void permissions.list()
    .then(async (apps) => { await cleanOrphanedAppPartitions(app.getPath('userData'), apps, isOriginServedFromCacheSync) })
    .catch((error: unknown) => { console.error('[orivon] clearing an orphaned app partition failed:', error) })
}
