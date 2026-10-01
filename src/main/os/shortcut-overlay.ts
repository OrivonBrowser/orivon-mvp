// The "Create shortcut" sheet. It is shown for one tab's address, stored here when the sheet opens, and asks for one
// thing back: make the shortcut, under this name, for this profile or not. The page never sends an address or a path.
import { originFromUrl } from '../../broker/policy/origin.js'
import { DEFAULT_PROFILE_ID, PROFILE_ID } from '../launch/launch-context.js'
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef } from '../overlays/overlay-types.js'
import { SHORTCUT_OVERLAY, shortcutAddressFor } from './shortcut-open.js'
import { cleanName, MAX_NAME } from './site-shortcut.js'
import { createShortcut } from './site-shortcut-runner.js'
import type { ShortcutHost } from './site-shortcut-runner.js'

const SHEET_WIDTH = 400
/** An address longer than this is not one a file or a sheet should carry. */
const MAX_ADDRESS = 32768
/** What the page may send as a name before it is cut: far past `MAX_NAME`, so a paste is shortened, not refused. */
const MAX_TYPED_NAME = 1000

interface Shown {
  readonly url: string
  readonly title: string
}

function asShown (payload: unknown): Shown | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { url, title } = payload as Record<string, unknown>
  if (typeof url !== 'string' || typeof title !== 'string' || url.length > MAX_ADDRESS) return undefined
  const address = shortcutAddressFor({ isNewTab: false, isInternal: false, displayUrl: url })
  return address === undefined ? undefined : { url: address, title }
}

interface CreateCommand {
  readonly name: string
  readonly thisProfile: boolean
}

function asCreate (command: unknown): CreateCommand | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, name, thisProfile, ...rest } = command as Record<string, unknown>
  if (type !== 'create' || typeof name !== 'string' || name.length > MAX_TYPED_NAME || typeof thisProfile !== 'boolean' || Object.keys(rest).length > 0) return undefined
  return { name, thisProfile }
}

export function shortcutOverlayFor (host: ShortcutHost): OverlayDef {
  return {
    name: SHORTCUT_OVERLAY,
    placement: { kind: 'area', at: 'center', width: SHEET_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'popup',
    // A sheet about one page: it goes when the tab changes or the page navigates.
    closeOn: { ...CLOSE_LIKE_POPUP, navigation: true, layout: false },
    keep: 'fresh',
    height: { initial: 300, min: 200, max: 420 },
    attach: ({ services }) => {
      let shown: Shown | undefined
      /** The profile the shortcut may name: another one than the default, with a well-formed id. */
      const profile = (): { id: string, name: string } | undefined => {
        const own = services.profiles.list().find((row) => row.current)
        return own !== undefined && own.id !== DEFAULT_PROFILE_ID && PROFILE_ID.test(own.id) ? { id: own.id, name: own.name } : undefined
      }
      return {
        show: (payload) => {
          shown = asShown(payload)
          if (shown === undefined) return undefined
          const own = profile()
          return {
            origin: originFromUrl(shown.url) ?? new URL(shown.url).host,
            name: cleanName(shown.title, new URL(shown.url).hostname),
            maxName: MAX_NAME,
            ...(own === undefined ? {} : { profileName: own.name })
          }
        },
        request: async (command) => {
          const create = asCreate(command)
          if (create === undefined || shown === undefined || services.isPrivate) return undefined
          const own = create.thisProfile ? profile() : undefined
          return await createShortcut(host, {
            name: cleanName(create.name, new URL(shown.url).hostname),
            address: shown.url,
            ...(own === undefined ? {} : { profileId: own.id })
          })
        }
      }
    }
  }
}
