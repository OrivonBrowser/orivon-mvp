// Requests the extensions page makes beyond the core ones in
// extensions-domain.ts: a feature adds its own here, keyed by the request's
// `type`. The domain has already checked that the request came from the
// extensions page; a command checks its own arguments, since every field is
// data from a document.
import type { InternalCaller } from '../pages/internal-ipc.js'
import type { ExtensionsDomainDeps } from './extensions-domain.js'
import { shortcutsCancel, shortcutsClear, shortcutsList, shortcutsMove, shortcutsRecord } from './shortcuts-page.js'

/** `caller` is the page's own webContents, for a command that waits on the next key press in it. */
export type ExtensionPageCommand = (body: Readonly<Record<string, unknown>>, deps: ExtensionsDomainDeps, caller: InternalCaller) => unknown

/** One per line, alphabetical. */
export const EXTENSION_PAGE_COMMANDS: Readonly<Record<string, ExtensionPageCommand>> = {
  'shortcuts.cancel': shortcutsCancel,
  'shortcuts.clear': shortcutsClear,
  'shortcuts.list': shortcutsList,
  'shortcuts.move': shortcutsMove,
  'shortcuts.record': shortcutsRecord
}
