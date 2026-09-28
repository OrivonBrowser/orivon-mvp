// The application menu. Linux and Windows have none: the browser draws its
// own chrome, and a menu there would take keys before the dispatcher sees
// them. macOS needs one to exist (its Edit menu is what makes copy and paste
// work), so it gets the standard roles plus a menu per category listing the
// commands. Their accelerators are for display only; ./dispatcher.ts runs them.
import type { MenuItemConstructorOptions } from 'electron'
import type { Chord, Platform } from './accelerator.js'
import { COMMANDS } from './commands.js'
import type { CommandCategory, CommandId } from './commands.js'
import type { ShortcutService } from './shortcut-service.js'

const TITLES: Readonly<Record<CommandCategory, string>> = { tabs: 'Tab', navigation: 'Go', window: 'Window' }

/** A chord in Electron's accelerator spelling. */
export function toElectronAccelerator (chord: Chord, platform: Platform): string {
  const parts: string[] = []
  if (chord.ctrl) parts.push('Ctrl')
  if (chord.alt) parts.push('Alt')
  if (chord.shift) parts.push('Shift')
  if (chord.meta) parts.push(platform === 'darwin' ? 'Command' : 'Super')
  parts.push(chord.key === '+' ? 'Plus' : chord.key === 'Escape' ? 'Esc' : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key)
  return parts.join('+')
}

/** Null where there is to be no menu. */
export function buildAppMenuTemplate (service: ShortcutService, run: (id: CommandId) => void): MenuItemConstructorOptions[] | null {
  if (service.platform !== 'darwin') return null
  const categories: CommandCategory[] = ['tabs', 'navigation', 'window']
  return [
    { role: 'appMenu' },
    { role: 'editMenu' },
    ...categories.map((category): MenuItemConstructorOptions => ({
      label: TITLES[category],
      submenu: COMMANDS.filter((command) => command.category === category).map((command): MenuItemConstructorOptions => {
        const chord = service.primary(command.id)
        return {
          label: command.label,
          ...(chord === null ? {} : { accelerator: toElectronAccelerator(chord, service.platform) }),
          registerAccelerator: false,
          click: () => { run(command.id) }
        }
      })
    })),
    { role: 'windowMenu' }
  ]
}
