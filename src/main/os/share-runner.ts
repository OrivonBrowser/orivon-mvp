// The share commands wired to the real machine: the clipboard, the confirmation box and the mail program.
import { clipboard, shell } from 'electron'
import { confirmExternalLink } from '../shell/external-link-prompt.js'
import type { ShareDeps } from './share-commands.js'

export const realShareDeps: ShareDeps = {
  writeClipboard: (text) => { clipboard.writeText(text).catch((error: unknown) => { console.error('[os] copying to the clipboard failed:', error) }) },
  confirm: confirmExternalLink,
  openExternal: async (url) => { await shell.openExternal(url) }
}
