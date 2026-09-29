// Answers the vendored preload's own synchronous "is this frame one of its
// own extension's declared sandbox.pages" query
// (EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL, ../channels.ts's own doc) --
// before that preload ever calls injectExtensionAPIs(), so a sandboxed
// page's own document_start script never sees a window.chrome even
// briefly (UPSTREAM.md patch 37). Split out of extension-host.ts (Rule 2,
// that file's own line budget) as its own concern: this file answers one
// question from a sender frame's own URL and its extension's real loaded
// manifest, never anything the calling preload's query itself could pass.
import { ipcMain, session } from 'electron'
import { isSandboxPageUrl } from 'orivon:crx-extensions-router'
import { extensionIdFromScope } from './extension-sw-preload-recovery.js'
import { EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL } from '../channels.js'

function isSenderDeclaredSandboxPage (frame: Electron.WebFrameMain | null): boolean {
  if (frame === null) return false
  const id = extensionIdFromScope(frame.url)
  if (id === undefined) return false
  const manifest = session.defaultSession.extensions.getExtension(id)?.manifest as { sandbox?: { pages?: string[] } } | undefined
  return isSandboxPageUrl(manifest?.sandbox?.pages, frame.url)
}

/** Call once, before the first extension loads (createExtensionHost). */
export function registerSandboxPageQuery (): void {
  ipcMain.on(EXTENSION_SANDBOX_PAGE_QUERY_CHANNEL, (event) => {
    event.returnValue = isSenderDeclaredSandboxPage(event.senderFrame)
  })
}
