// Queue item 4.4's "full permissions page in settings" half of d-0027 --
// every installed app, and what each one can do, with revoke. A dedicated
// small BaseWindow rather than a tab or a panel inside the chrome view:
// the chrome view is fixed at CHROME_HEIGHT (window.ts, 104px) on purpose
// (src/renderer/README.md's three-places-in-sync layout constant), so it
// has nowhere to grow a real list of cards without resizing/reordering the
// native view live -- a change this lane chose not to make unverified
// (no Electron launch available in this environment; see this lane's PR
// body). A second top-level window sidesteps that entirely: any size,
// any content height, no interaction with TabManager or the chrome view
// at all.
//
// SINGLETON. Calling this twice while a settings window is already open
// focuses the existing one rather than opening a second -- there is only
// ever one true state to show. KNOWN, DISCLOSED LIMITATION: `focusOrigin`
// (which app's card to scroll to) is only applied on a FRESH open, via
// `additionalArguments` (fixed at WebContentsView construction, same
// mechanism tab-view.ts's `appTabArgsFor` uses) -- re-focusing an
// ALREADY-OPEN window for a different origin does not scroll it there,
// it only raises the window. Fixing that needs a live main -> renderer
// push once the window is already open, which this lane did not build.

import { BaseWindow, ipcMain, WebContentsView } from 'electron'
import { join } from 'node:path'
import { SETTINGS_COMMAND_CHANNEL } from './channels.js'
import type { PermissionsController } from './permissions.js'
import { rendererEntryUrl } from './renderer-entry.js'
import { registerSettingsIpc } from './settings-ipc.js'

const WIDTH = 480
const HEIGHT = 640

let current: BaseWindow | null = null

/** Opens the permissions settings window, or focuses it if already open.
 * `focusOrigin`, when given, is the origin whose card the page should
 * scroll to on load -- see this file's own header for why that only takes
 * effect on a fresh open. */
export function openSettingsWindow (permissions: PermissionsController, focusOrigin?: string): void {
  if (current !== null && !current.isDestroyed()) {
    current.focus()
    return
  }

  const url = rendererEntryUrl(import.meta.dirname, process.env['ELECTRON_RENDERER_URL'], '/settings/', '../renderer/settings/index.html')

  // Two flags, same mechanism newtab.ts's own `--orivon-newtab-url=` uses:
  // `--orivon-settings-url=` lets the preload verify `location.href`
  // before exposing anything privileged (defense in depth -- this page
  // never navigates on its own, but the preload does not trust that from
  // its own side); `--orivon-focus-origin=` is this open's scroll target,
  // when there is one.
  const win = new BaseWindow({ width: WIDTH, height: HEIGHT, title: 'Orivon Permissions' })
  const view = new WebContentsView({
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/settings.js'),
      additionalArguments: [
        `--orivon-settings-url=${url}`,
        ...(focusOrigin !== undefined ? [`--orivon-focus-origin=${focusOrigin}`] : [])
      ],
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })
  win.contentView.addChildView(view)

  function layout (): void {
    const bounds = win.getContentBounds()
    view.setBounds({ x: 0, y: 0, width: bounds.width, height: bounds.height })
  }
  layout()
  win.on('resize', layout)

  void view.webContents.loadURL(url)

  registerSettingsIpc(view.webContents, permissions)

  // Same cleanup rule window.ts applies to COMMAND_CHANNEL/
  // NEWTAB_COMMAND_CHANNEL: ipcMain.handle throws if the same channel is
  // registered twice with no matching removeHandler between -- reachable
  // here because a person can close and reopen the settings window many
  // times in one browser session.
  win.on('closed', () => {
    ipcMain.removeHandler(SETTINGS_COMMAND_CHANNEL)
    current = null
  })

  current = win
}
