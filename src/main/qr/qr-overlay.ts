// The QR sheet: the page draws the code from the address main hands it, and asks for exactly two things back,
// copy the link or save the picture. What to copy is the address main stored at show time, never a field the page sends.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { QR_OVERLAY } from './qr-open.js'
import { saveQrPng } from './qr-download.js'
import type { QrSaveDeps } from './qr-download.js'
import type { SettingsStore } from '../settings/settings-store.js'

const SHEET_WIDTH = 300
/** An address longer than this is not something a clipboard write or a sheet should carry. */
const MAX_ADDRESS = 32768

export interface QrDeps extends Omit<QrSaveDeps, 'downloadsDir'> {
  writeClipboard: (text: string) => void
  /** The folder downloads go to, which follows the person's Downloads setting. */
  downloadsDir: (settings: Pick<SettingsStore, 'get'>) => string
}

type QrCommand = { type: 'copy' } | { type: 'download', png: string }

function asCommand (command: unknown): QrCommand | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, png, ...rest } = command as Record<string, unknown>
  if (type === 'copy' && png === undefined && Object.keys(rest).length === 0) return { type }
  if (type === 'download' && typeof png === 'string' && Object.keys(rest).length === 0) return { type, png }
  return undefined
}

function asAddress (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { url } = payload as Record<string, unknown>
  return typeof url === 'string' && url.length > 0 && url.length <= MAX_ADDRESS ? url : undefined
}

export function qrOverlayFor (deps: QrDeps): OverlayDef {
  return {
    name: QR_OVERLAY,
    placement: { kind: 'area', at: 'top-right', width: SHEET_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'popup',
    // A sheet about one page: it is gone when the tab changes or the page navigates.
    closeOn: { ...CLOSE_LIKE_POPUP, navigation: true },
    keep: 'fresh',
    height: { initial: 420, min: 300, max: 480 },
    attach: ({ services }) => {
      let address: string | undefined
      return {
        show: (payload) => {
          address = asAddress(payload)
          return address === undefined ? undefined : { url: address }
        },
        request: async (command) => {
          const request = asCommand(command)
          if (request === undefined || address === undefined) return undefined
          if (request.type === 'copy') {
            // The write is synchronous, so nothing here could cut a stalled one short: it either returns or throws.
            try {
              deps.writeClipboard(address)
              return { ok: true }
            } catch {
              return { ok: false }
            }
          }
          return { ok: await saveQrPng({ ...deps, downloadsDir: () => deps.downloadsDir(services.settings) }, address, request.png) !== undefined }
        }
      }
    }
  }
}
