// Which webContents show one of the shell's own pages: a registered internal
// page (Settings, ...) or any other view running in the shell's own session
// -- the chrome, its popovers, the intro screen, the split frame's backdrop
// (shell-session.ts). DevToolsService gates every one of these on developer
// mode through this, not only the ones registered as internal pages.
import type { Session, WebContents } from 'electron'
import type { InternalPageRegistry } from '../pages/internal-registry.js'

export function isShellUiPage (contents: WebContents, internalPages: InternalPageRegistry, shellSession: Session): boolean {
  return internalPages.pageOf(contents) !== undefined || contents.session === shellSession
}
