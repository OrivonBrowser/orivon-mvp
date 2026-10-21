// Wires scheme routing (d-0596) to the running shell once it exists: the apps come from the broker, the choices from
// the profile, the questions from the panel, the tabs from the window registry. Publishes the host the control
// channel reads (`ctx.schemeHost`) and hands the gate its routing. Tied to Electron through what it is given.
import type { BaseWindow } from 'electron'
import { configureLinkRouting } from '../sessions/permission-gate.js'
import type { SubsystemContext } from '../registry.js'
import { publishSchemeHost } from '../registry.js'
import { chooseLinkApp, confirmSchemeDefault } from '../shell/external-link-prompt.js'
import type { ShellServices } from '../shell/shell-services.js'
import { createAppDirectory } from './app-directory.js'
import { OpenUrlQueue } from './open-url-queue.js'
import { createSchemeRouting } from './scheme-routing.js'
import { showApp } from './show-app.js'

export function installSchemeRouting (ctx: SubsystemContext, shell: Pick<ShellServices, 'schemeChoices' | 'windows'>): void {
  const { routing, host } = createSchemeRouting<BaseWindow>({
    apps: createAppDirectory(() => ctx.broker),
    choices: shell.schemeChoices,
    queue: new OpenUrlQueue(),
    chooseApp: async (_window, question, apps, tab) => await chooseLinkApp({ contents: tab }, question, apps),
    confirmDefault: async (tab, question) => await confirmSchemeDefault({ contents: tab }, question),
    showApp: (origin, from) => { showApp(shell.windows, origin, from) }
  })
  publishSchemeHost(ctx, host)
  configureLinkRouting(routing)
}
