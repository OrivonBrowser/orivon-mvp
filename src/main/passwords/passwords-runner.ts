// The Electron side of the Passwords domain: the clipboard, the file dialogs for the window the page is in, and
// the two files an import reads and an export writes.
import { open, stat } from 'node:fs/promises'
import { clipboard } from 'electron'
import { pickOpenFile, pickSaveFile } from '../shell/file-dialogs.js'
import type { ShellServices } from '../shell/shell-services.js'
import { devRevealHideMs } from './dev-password-storage.js'
import { passwordsDomain, REVEAL_HIDE_MS } from './passwords-domain.js'
import type { PasswordsHost, ReadResult } from './passwords-domain.js'
import { secretClipboard } from './secret-clipboard.js'
import { writePrivate } from './write-private.js'
import type { InternalDomain } from '../pages/internal-ipc.js'

const CSV_FILTERS = [{ name: 'Passwords (CSV)', extensions: ['csv'] }, { name: 'All files', extensions: ['*'] }]

async function readBounded (path: string, maxBytes: number): Promise<ReadResult> {
  try {
    if ((await stat(path)).size > maxBytes) return { ok: false, reason: 'too-large' }
    const handle = await open(path, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      return bytesRead > maxBytes ? { ok: false, reason: 'too-large' } : { ok: true, text: buffer.toString('utf8', 0, bytesRead) }
    } finally {
      await handle.close()
    }
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
}

export function passwordsHost (services: Pick<ShellServices, 'passwords' | 'windows'>): PasswordsHost {
  return {
    vault: services.passwords,
    clipboard: secretClipboard({
      write: async (text) => { await clipboard.writeText(text) },
      read: async () => await clipboard.readText(),
      clear: () => { clipboard.clear() }
    }),
    revealHideMs: devRevealHideMs() ?? REVEAL_HIDE_MS,
    pickImport: async (caller) => await pickOpenFile(services.windows.findOwner(caller.contents)?.window, { title: 'Import passwords', filters: CSV_FILTERS }),
    pickExport: async (caller, defaultName) => await pickSaveFile(services.windows.findOwner(caller.contents)?.window, { title: 'Export passwords', defaultPath: defaultName, filters: CSV_FILTERS }),
    readFile: readBounded,
    writeFile: writePrivate
  }
}

export function passwordsDomainFor (services: Pick<ShellServices, 'passwords' | 'windows'>): InternalDomain {
  return passwordsDomain(passwordsHost(services))
}
