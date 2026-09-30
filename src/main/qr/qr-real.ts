// The QR sheet wired to the real machine, for the registry in ../overlays/overlays.ts.
import { app, clipboard } from 'electron'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { qrOverlayFor } from './qr-overlay.js'

export const qrOverlay = qrOverlayFor({
  writeClipboard: (text) => { clipboard.writeText(text) },
  downloadsDir: () => app.getPath('downloads'),
  exists: existsSync,
  writeFile: async (path, data) => { await writeFile(path, data, { flag: 'wx' }) }
})
