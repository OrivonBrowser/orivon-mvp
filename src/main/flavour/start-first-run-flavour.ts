// Wires the first-run flavour into a launch: reads the carriers, applies the one they name, and hands back what waits for the
// welcome screen. Called by index.ts for an ordinary window of the default profile, before the first window is made.
import { startsFromDefaultProfile } from '../default-profile/profile-start.js'
import type { ShellServices } from '../shell/shell-services.js'
import { AfterWelcome } from './after-welcome.js'
import { carriersOf } from './carriers.js'
import { applyFirstRunFlavour, installFirstRunFlavour } from './first-run-flavour.js'
import { parseFlavours, taggedId } from './flavours.js'
import flavourList from '../../../resources/flavours.json'

export function startFirstRunFlavour (shell: ShellServices, dir: string, isDefaultProfile: boolean, argv: readonly string[], env: NodeJS.ProcessEnv, execPath: string): AfterWelcome {
  const afterWelcome = new AfterWelcome()
  installFirstRunFlavour({
    dir,
    isNewDefaultProfile: isDefaultProfile && !shell.kiosk && startsFromDefaultProfile(),
    flavours: parseFlavours(flavourList),
    featured: shell.featured,
    openApp: (address) => {
      afterWelcome.whenEnded(() => {
        const tabs = shell.windows.focused()?.tabs
        if (tabs === undefined) return
        // The way a tile on the new tab opens an app: a fresh tab, then the navigation the address bar would make.
        tabs.navigate(tabs.createTab(), address)
      })
    }
  })
  const id = taggedId(carriersOf(argv, env, execPath))
  if (id !== null) applyFirstRunFlavour(id)
  return afterWelcome
}
