import type { Section } from '../model.js'
import type { SettingsState } from '../state.js'
import type { PasswordsPart } from '../passwords/passwords-part.js'
import { renderGenerator, renderNeverSaved, renderPasswordsBanner, renderSavedPasswords } from '../passwords/passwords-view.js'

const part = (state: SettingsState): PasswordsPart => state.part<PasswordsPart>('passwords')
/** Saving and filling need a store that keeps passwords: not without a system keyring, not in a private window. */
const cannotKeep = (state: SettingsState): boolean => part(state).vault === 'unavailable' || part(state).vault === 'private'

export const passwords: Section = {
  id: 'passwords',
  title: 'Passwords',
  rows: [
    {
      id: 'password-storage',
      label: 'Password storage',
      keywords: ['keyring', 'keychain', 'gnome', 'kwallet', 'private', 'unencrypted', 'encrypted', 'status'],
      control: { type: 'custom', wide: true, render: renderPasswordsBanner },
      visible: cannotKeep
    },
    {
      id: 'passwords-offer-to-save',
      label: 'Offer to save passwords',
      help: 'Orivon asks after you sign in to a site. Passwords stay on this computer, encrypted with your system keyring.',
      keywords: ['password', 'save', 'remember', 'sign in', 'login', 'credentials', 'prompt'],
      control: { type: 'toggle', key: 'passwords.offerToSave', disabled: cannotKeep }
    },
    {
      id: 'passwords-autofill',
      label: 'Offer saved passwords when signing in',
      help: 'A password is filled only after you pick it.',
      keywords: ['password', 'autofill', 'fill', 'sign in', 'login', 'credentials'],
      control: { type: 'toggle', key: 'passwords.autofill', disabled: cannotKeep }
    },
    {
      id: 'saved-passwords',
      label: 'Saved passwords',
      help: 'Show, copy or delete a password, or move them to or from another browser or password manager with a CSV file.',
      keywords: ['password', 'saved', 'logins', 'credentials', 'show', 'reveal', 'copy', 'delete', 'import', 'export', 'csv'],
      control: { type: 'custom', wide: true, render: renderSavedPasswords }
    },
    {
      id: 'passwords-never',
      label: 'Never saved',
      help: 'Orivon does not offer to save passwords for these sites.',
      keywords: ['password', 'never', 'exceptions', 'sites', 'blocked', 'save'],
      control: { type: 'custom', wide: true, render: renderNeverSaved },
      visible: (state) => part(state).never.length > 0
    },
    {
      id: 'password-generator',
      label: 'Generate a password',
      help: 'Makes a strong 20-character password to copy. It is not saved.',
      keywords: ['password', 'generate', 'generator', 'random', 'strong', 'suggest'],
      control: { type: 'custom', wide: true, render: renderGenerator }
    }
  ]
}
