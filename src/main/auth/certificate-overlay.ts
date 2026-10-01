// The certificate viewer: the chain the active tab's host presented, read here from what the verify proc noted.
// The page can ask for one thing: the PEM of one certificate of the chain it was shown, copied by main.
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { CERTIFICATE_OVERLAY } from './auth-names.js'
import { activeHttpsHost } from './certificate-open.js'
import type { CertificateCache } from './certificate-cache.js'
import type { CertificateView } from './certificate-view.js'

const SHEET_WIDTH = 520
/** The clipboard can stall under a display with no clipboard owner; the sheet must not wait on it. */
const CLIPBOARD_LIMIT_MS = 1000

export interface CertificateDeps {
  readonly cache: CertificateCache
  readonly writeClipboard: (text: string) => void
}

/** What the page is shown: the host and its chain, or a null chain when no connection has presented one yet. */
export interface CertificatePage {
  readonly host: string
  readonly chain: readonly CertificateView[] | null
}

type Command = { type: 'copyPem', index: number }

function asCommand (command: unknown): Command | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, index, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0) return undefined
  return type === 'copyPem' && typeof index === 'number' && Number.isInteger(index) ? { type, index } : undefined
}

export function certificateOverlayFor (deps: CertificateDeps): OverlayDef {
  return {
    name: CERTIFICATE_OVERLAY,
    placement: { kind: 'area', at: 'center', width: SHEET_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'popup',
    closeOn: CLOSE_LIKE_POPUP,
    keep: 'fresh',
    height: { initial: 320, min: 240, max: 460 },
    attach: ({ window }) => {
      /** The chain the page on screen was shown, so a copy names a row of it and nothing else. */
      let shown: readonly CertificateView[] = []
      return {
        show: (): CertificatePage | undefined => {
          const host = activeHttpsHost(window)
          if (host === undefined) { shown = []; return undefined }
          const cached = deps.cache.get(host)
          shown = cached?.chain ?? []
          return { host, chain: cached?.chain ?? null }
        },
        request: async (command) => {
          const asked = asCommand(command)
          if (asked === undefined) return undefined
          const pem = shown[asked.index]?.pem
          if (pem === undefined) return { ok: false }
          const written = new Promise<boolean>((resolve) => {
            try {
              deps.writeClipboard(pem)
              resolve(true)
            } catch {
              resolve(false)
            }
          })
          const limit = new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, CLIPBOARD_LIMIT_MS).unref() })
          return { ok: await Promise.race([written, limit]) }
        }
      }
    }
  }
}
