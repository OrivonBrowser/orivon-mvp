// Builds the one controller the site-info popover and the Settings page share, over the services this process
// holds. Memoised by the services object, so both surfaces see the same listeners and one answer.
import type { SubsystemContext } from '../registry.js'
import { notificationDecisions } from '../sessions/permission-gate.js'
import type { ShellServices } from '../shell/shell-services.js'
import { isAppOrigin } from './app-origin.js'
import { createSiteSettingsController, type SiteSettingsController } from './site-settings-controller.js'

const controllers = new WeakMap<ShellServices, SiteSettingsController>()

export function siteSettingsControllerFor (services: ShellServices, ctx: SubsystemContext): SiteSettingsController {
  let controller = controllers.get(services)
  if (controller === undefined) {
    controller = createSiteSettingsController({
      store: services.siteSettings,
      notifications: notificationDecisions(),
      defaultFor: (kind) => {
        const value = services.settings.get(kind.settingKey)
        return value === 'allow' || value === 'block' || value === 'ask' ? value : 'ask'
      },
      isApp: (origin) => isAppOrigin(ctx, origin)
    })
    controllers.set(services, controller)
  }
  return controller
}
