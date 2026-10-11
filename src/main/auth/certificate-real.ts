// The certificate viewer wired to the real machine, for the registry in ../overlays/overlays.ts.
import { clipboard } from 'electron'
import { certificateOverlayFor } from './certificate-overlay.js'
import { certificates } from './note-certificate.js'

export const certificateOverlay = certificateOverlayFor({
  cache: certificates,
  writeClipboard: (text) => { clipboard.writeText(text) }
})
