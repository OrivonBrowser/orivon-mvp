// The share commands wired to the real machine: the clipboard, the confirmation box and the mail program.
import { shell } from 'electron'
import { confirmExternalLink } from '../shell/external-link-prompt.js'
import { writeClip } from './address-clipboard-runner.js'
import type { ShareDeps } from './share-commands.js'

export const realShareDeps: ShareDeps = {
  writeClipboard: writeClip,
  confirm: confirmExternalLink,
  openExternal: async (url) => { await shell.openExternal(url) }
}
