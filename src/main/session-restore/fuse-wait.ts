// A saved tab that is a local file can open only once the binary's file-protocol fuse has been read (../local-files/file-fuse.ts).
import { localFileKey } from '../../broker/policy/origin.js'
import { fileProtocolFuse, knownFileProtocolFuse } from '../local-files/file-fuse.js'

/** Whether any of `tabs` is a local file. */
export function holdsLocalFile (tabs: readonly { readonly url: string }[]): boolean {
  return tabs.some((tab) => localFileKey(tab.url) !== null)
}

/**
 * When `needed` and the fuse has not been read yet, starts the read, calls `later` once it is in and answers
 * true; otherwise does nothing and answers false, and the caller goes on. A restored tab that opens before the
 * read has no id to give its pin, title, history and group to, and its place is lost.
 */
export function deferUntilFuseKnown (needed: boolean, later: () => void): boolean {
  if (!needed || knownFileProtocolFuse() !== undefined) return false
  void fileProtocolFuse().then(later, later)
  return true
}
