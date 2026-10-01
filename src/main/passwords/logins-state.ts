import type { ShellStatePart } from '../shell/shell-state-parts.js'
import { formsFor } from './forms-registry.js'
import { oncePerTurn } from './once-per-turn.js'

/** What the address bar's password button needs of the active tab: the logins its sign-in form could use, and whether an offer to keep one is waiting. */
export const loginsStatePart: ShellStatePart = {
  name: 'logins',
  read: ({ window, services }, tabs) => ({ logins: formsFor(window, services).loginState(tabs.activeTabId) }),
  watch: ({ window, services }, push) => {
    // An import saves a row at a time: the button hears of the whole import once.
    const vaultChanged = oncePerTurn(push)
    const stops = [
      formsFor(window, services).onChange(push),
      services.passwords.onChange(vaultChanged),
      vaultChanged.cancel,
      services.settings.onChange(({ key }) => { if (key.startsWith('passwords.')) push() })
    ]
    return () => { for (const stop of stops) stop() }
  }
}
