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
import { installDefaultBrowserAsk } from '../os/install-default-browser-ask.js'
import { installDisplayCapture } from '../display-capture/install-display-capture.js'
import { installDisplayUi } from '../display-capture/install-display-ui.js'
import { installFocus } from '../focus/install-focus.js'
import { installLauncherMenu } from '../os/install-launcher-menu.js'
import { installMediaGrants } from '../media-grants/install-media-grants.js'
import { installMemorySaver } from '../memory-saver/install-memory-saver.js'
import { installTabSlots } from '../overlays/install-tab-slots.js'
import { installTabVisibility } from './install-tab-visibility.js'
import { installFormWatch } from '../passwords/install-form-watch.js'
import { installEthGatewayRedirect } from './eth-gateway-redirect.js'
import { installPrivacyNet } from '../privacy/install-privacy-net.js'
import { installReader } from '../reader/install-reader.js'
import { installLoadErrors } from '../sad-tab/install-load-errors.js'
import { installQuestions } from './question/install-questions.js'
import { installSidePanel } from '../side-panel/install-side-panel.js'
import { installContentSettings } from '../site-settings/install-content-settings.js'
import { installSitePermissions } from '../site-settings/install-site-permissions.js'
import { installTabGroups } from '../tab-groups/install-tab-groups.js'
import type { ShellServices } from './shell-services.js'

export interface ShellInstaller {
  readonly name: string
  install: (app: App, services: ShellServices, ctx: SubsystemContext, runtime: Runtime) => void
}

// Order is the order the per-site askers answer in: the first answer that is not `undefined` wins. `media-grants`
// must stay ahead of `site-permissions`, which refuses every app origin, so an app's camera goes to its grant.
export const SHELL_INSTALLERS: readonly ShellInstaller[] = [
  installAuth,
  installAutofill,
  installChoosers,
  installContentSettings,
  installDefaultBrowserAsk,
  installDisplayCapture,
  installDisplayUi,
  installEthGatewayRedirect,
  installFocus,
  installFormWatch,
  installLauncherMenu,
  installLoadErrors,
  installMediaGrants,
  installMemorySaver,
  installPrivacyNet,
  installQuestions,
  installReader,
  installSidePanel,
  installSitePermissions,
  installTabGroups,
  installTabSlots,
  installTabVisibility
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
