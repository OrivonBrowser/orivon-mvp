// Spell checking on every tab's session, from the `spellcheck.enabled` setting.
// A tab is known to be one only once its window has registered it, which is
// after its webContents exists, so the session is claimed at the first load event.
import type { App, Session, WebContents } from 'electron'
import type { SettingsStore } from '../settings/settings-store.js'
import type { WindowRegistry } from '../shell/window-registry.js'
import { SpellcheckSessions } from './spellcheck.js'

type Claimable = Pick<WebContents, 'on' | 'removeListener' | 'isDestroyed'> & { readonly session: Pick<Session, 'setSpellCheckerEnabled'> }

/** Tracks `contents`' session once `isTab` says it is a tab; listens until then. */
export function claimTabSession (contents: Claimable, isTab: () => boolean, sessions: SpellcheckSessions): void {
  const claim = (): void => {
    if (contents.isDestroyed() || !isTab()) return
    contents.removeListener('did-start-loading', claim)
    contents.removeListener('dom-ready', claim)
    contents.removeListener('did-finish-load', claim)
    sessions.track(contents.session)
  }
  contents.on('did-start-loading', claim)
  contents.on('dom-ready', claim)
  contents.on('did-finish-load', claim)
}

export function installSpellcheck (app: Pick<App, 'on'>, windows: WindowRegistry, settings: SettingsStore): void {
  const sessions = new SpellcheckSessions(() => settings.get('spellcheck.enabled'))
  settings.onChange(({ key }) => { if (key === 'spellcheck.enabled') sessions.refresh() })
  app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') claimTabSession(contents, () => windows.findTab(contents) !== null, sessions)
  })
}
