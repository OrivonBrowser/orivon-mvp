// What a feature wires once the shell's services exist: listeners on the app,
// on sessions, on every web contents. `index.ts` runs the list right after
// the settings are loaded, so an installer may read them. One line per
// installer in SHELL_INSTALLERS, alphabetical.
import type { App } from 'electron'
import type { Runtime } from '../launch/start-launch.js'
import type { SubsystemContext } from '../registry.js'
import { installAuth } from '../auth/install-auth.js'
import { installAutofill } from '../autofill/install-autofill.js'
import { installChoosers } from '../devices/install-choosers.js'
import { installTabSlots } from '../overlays/install-tab-slots.js'
import { installFormWatch } from '../passwords/install-form-watch.js'
import { installPrivacyNet } from '../privacy/install-privacy-net.js'
import { installContentSettings } from '../site-settings/install-content-settings.js'
import { installSitePermissions } from '../site-settings/install-site-permissions.js'
import type { ShellServices } from './shell-services.js'

export interface ShellInstaller {
  readonly name: string
  install: (app: App, services: ShellServices, ctx: SubsystemContext, runtime: Runtime) => void
}

export const SHELL_INSTALLERS: readonly ShellInstaller[] = [
  installAuth,
  installAutofill,
  installChoosers,
  installContentSettings,
  installFormWatch,
  installPrivacyNet,
  installSitePermissions,
  installTabSlots
]

/** An installer that throws is logged and skipped: one feature failing to wire must not stop the others or the first window. */
export function runShellInstallers (
  app: App, services: ShellServices, ctx: SubsystemContext, runtime: Runtime, installers: readonly ShellInstaller[] = SHELL_INSTALLERS
): void {
  for (const installer of installers) {
    try {
      installer.install(app, services, ctx, runtime)
    } catch (error) {
      console.error(`[shell] the ${installer.name} installer failed:`, error)
    }
  }
}
