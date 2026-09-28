// What changing a setting does to the rest of the browser, for the settings
// whose effect is not read on demand by the code that uses them.
import type { NativeTheme } from 'electron'
import type { SettingsStore } from './settings-store.js'

/** Makes the OS-level theme follow the setting, now and on every change. It
 * reaches the chrome, every internal page and the sites themselves, since all
 * of them read `prefers-color-scheme`. Returns the removal. */
export function applyThemeSetting (settings: SettingsStore, nativeTheme: Pick<NativeTheme, 'themeSource'>): () => void {
  const apply = (): void => { nativeTheme.themeSource = settings.get('appearance.theme') }
  apply()
  return settings.onChange(({ key }) => { if (key === 'appearance.theme') apply() })
}
