// The QR sheet wired to the real machine, for the registry in ../overlays/overlays.ts.
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { downloadsFolder } from '../downloads/folder-runner.js'
import { copyAddress } from '../os/address-clipboard-runner.js'
import { qrOverlayFor } from './qr-overlay.js'

export const qrOverlay = qrOverlayFor({
  writeClipboard: copyAddress,
  downloadsDir: downloadsFolder,
  exists: existsSync,
  writeFile: async (path, data) => {
    // The chosen folder may not exist yet.
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { flag: 'wx' })
  }
})
