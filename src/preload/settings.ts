import { contextBridge, ipcRenderer } from 'electron'
import { SETTINGS_COMMAND_CHANNEL } from '../main/channels.js'
import type { SettingsCommand } from '../main/ipc/settings-ipc.js'
import type { AppPermissions } from '../main/permissions/permissions.js'
import type { CapabilityKind, GrantId } from '../contracts/index.js'

// Loaded ONLY by the permissions panel's own WebContentsView
// (src/main/permissions-panel.ts) -- queue item 4.4's permissions surface.
// This page never navigates anywhere else (no links, no
// address bar), but the check below still runs before exposing anything
// privileged -- the same defense-in-depth newtab.ts applies for a page that
// COULD navigate, kept here so this file is not the one preload in the
// codebase that trusts webPreferences.additionalArguments without checking
// location.href against it. src/main/settings-ipc.ts re-verifies the same
// thing from the authoritative main-process side, on every call; neither
// layer trusts the other.
const URL_PREFIX = '--orivon-settings-url='
const FOCUS_PREFIX = '--orivon-focus-origin='
const expectedUrl = process.argv.find((arg) => arg.startsWith(URL_PREFIX))?.slice(URL_PREFIX.length)
const focusOrigin = process.argv.find((arg) => arg.startsWith(FOCUS_PREFIX))?.slice(FOCUS_PREFIX.length)

if (expectedUrl !== undefined && location.href === expectedUrl) {
  contextBridge.exposeInMainWorld('orivonSettings', {
    list: async (): Promise<readonly AppPermissions[]> => {
      const result: unknown = await ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, { type: 'list' } satisfies SettingsCommand)
      return Array.isArray(result) ? result as AppPermissions[] : []
    },
    revoke: async (origin: string, grantId: GrantId): Promise<void> => {
      await ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, { type: 'revoke', origin, grantId } satisfies SettingsCommand)
    },
    revokeCapability: async (origin: string, capability: CapabilityKind): Promise<void> => {
      await ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, { type: 'revokeCapability', origin, capability } satisfies SettingsCommand)
    },
    revokePickedPath: async (origin: string, pickId: string): Promise<void> => {
      await ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, { type: 'revokePickedPath', origin, pickId } satisfies SettingsCommand)
    },
    /** Tells main how tall the rendered content is, so the panel sizes to it
     * (src/main/permissions-panel.ts). Fire-and-forget: a panel that failed
     * to resize is cosmetic, and must never break rendering the list. */
    reportHeight: (height: number): void => {
      void ipcRenderer.invoke(SETTINGS_COMMAND_CHANNEL, { type: 'contentHeight', height } satisfies SettingsCommand)
    },
    /** Read-only -- which app's card, if any, to scroll to on load. `null`
     * for an ordinary open from the toolbar's own "Permissions" button. */
    focusOrigin: focusOrigin ?? null
  })
}
// No else branch, unlike newtab.ts: this window is never anything BUT the
// settings page (it has no bookmarks bar, no address bar, nothing for a
// user to navigate away with), so there is no second, unprivileged surface
// to fall back to.
