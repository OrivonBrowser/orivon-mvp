import type { ShellState } from '../../main/shell/tabs.js'
import { passwordIcon } from '../pages/shared/icons.js'
import type { ChromeModule } from './context.js'

const LABEL = 'Saved passwords for this site'
const OFFER_LABEL = 'Save this password'

/** Whether the button shows: the page's sign-in form has a saved login or is a sign-up form, or an offer to keep the last sign-in is waiting. */
export function passwordKeyShown (logins: ShellState['logins']): boolean {
  return logins.offer || logins.count > 0 || logins.signUp
}

/** The password button in the address pill. A click asks main for the chooser, or for the save prompt when an offer is waiting. */
export function createPasswordKey (): ChromeModule {
  let button: HTMLButtonElement | undefined
  return {
    name: 'password-key',
    init: (ctx) => {
      const key = ctx.toolbarButton({
        id: 'password-key',
        slot: 'address',
        order: 20,
        label: LABEL,
        icon: passwordIcon,
        onClick: (el) => { void ctx.shell.act('passwords.key', { anchor: ctx.anchorFor(el) }) }
      })
      key.hidden = true
      key.setAttribute('aria-haspopup', 'dialog')
      button = key
    },
    render: (state) => {
      if (button === undefined) return
      button.hidden = !passwordKeyShown(state.logins)
      const label = state.logins.offer ? OFFER_LABEL : LABEL
      button.classList.toggle('has-offer', state.logins.offer)
      button.title = label
      button.setAttribute('aria-label', label)
    }
  }
}
