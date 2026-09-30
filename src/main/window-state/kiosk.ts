// Kiosk: a process started with --orivon-kiosk shows one page across the whole screen, with no tab strip,
// toolbar or way to open another window. Pure: the allow-list and the switch name.
import type { CommandId } from '../shortcuts/commands.js'

export const KIOSK_FLAG = '--orivon-kiosk'

/** The only commands a kiosk runs. Leaving is quit (Mod+Shift+Q) and nothing else: that is the point. */
const ALLOWED: ReadonlySet<CommandId> = new Set<CommandId>([
  'nav.back', 'nav.forward', 'nav.reload', 'nav.hardReload',
  'zoom.in', 'zoom.out', 'zoom.reset',
  'find.open', 'find.next', 'find.previous',
  'page.print',
  'app.quit'
])

export function kioskAllows (id: CommandId): boolean {
  return ALLOWED.has(id)
}
