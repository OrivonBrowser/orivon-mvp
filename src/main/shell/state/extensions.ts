import type { ShellStatePart } from '../shell-state-parts.js'

/** Whether the toolbar shows the Extensions button: `auto` while at least one extension is loaded, and in a private window only while one is, since the ones that run there are the few the person allowed and `always` has nothing to open without them. */
export function extensionsButtonShown (mode: 'auto' | 'always' | 'never', enabled: number, isPrivate: boolean): boolean {
  if (mode === 'never') return false
  return (mode === 'always' && !isPrivate) || enabled > 0
}

/** How many extensions are loaded and whether the button shows; both follow the setting and the loaded extensions live. */
export const extensionsStatePart: ShellStatePart = {
  name: 'extensions',
  read: ({ services }) => {
    const enabled = services.extensionsLoaded.count()
    return { extensions: { enabled, shown: extensionsButtonShown(services.settings.get('toolbar.extensions'), enabled, services.isPrivate) } }
  },
  watch: ({ services }, push) => {
    const stopSetting = services.settings.onChange(({ key }) => { if (key === 'toolbar.extensions') push() })
    const stopLoaded = services.extensionsLoaded.onChange(push)
    return () => { stopSetting(); stopLoaded() }
  }
}
