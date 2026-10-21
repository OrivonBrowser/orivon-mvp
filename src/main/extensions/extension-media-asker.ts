// Wires the camera and microphone rules for an extension's own page
// (`extension-media.ts`) into the permission gate's registry, ahead of the
// per-site asker. Tied to Electron: it reads the window a page is showing in,
// the loaded extensions of its session and the shell's settings.
import type { Session, WebContents } from 'electron'
import type { SubsystemContext } from '../registry.js'
import { siteAsks, type SiteAsker } from '../sessions/site-asks.js'
import { windowShowing } from '../shell/showing-window.js'
import type { ShellWindow } from '../shell/window-registry.js'
import { siteKindById } from '../site-settings/kinds.js'
import { askLines } from '../site-settings/site-prompt-text.js'
import { shellServices } from './extension-host.js'
import { createExtensionMedia, type MediaKind } from './extension-media.js'
import type { ExtensionPrefsStore } from './extension-prefs.js'
import { readExtensionFacts } from './extensions-view-runner.js'
import { createNagLimit } from './permission-nag-limit.js'
import { askPermissionChoice, clipName } from './permission-prompt-overlay.js'

interface Place {
  readonly window: ShellWindow
  readonly tabId: string
}

/**
 * Where the person would meet a question for `contents`: the window it is on screen in, whether that is a tab, an
 * open toolbar popup or a side panel (each is a view of the window while it shows). A page that is in no window, a
 * background tab and a window that is minimised or hidden have none.
 */
export function placeOf (contents: WebContents): Place | undefined {
  const windows = shellServices()?.windows
  const shown = windowShowing(contents)
  if (windows === undefined || shown === undefined || !shown.isVisible() || shown.isMinimized()) return undefined
  const window = windows.all().find((entry) => entry.window === shown)
  const tabId = windows.findTab(contents)?.tabId ?? window?.tabs.getState().activeTabId
  return window === undefined || tabId === undefined || tabId === null ? undefined : { window, tabId }
}

export function createExtensionMediaAsker (options: { ctx: SubsystemContext, prefs: ExtensionPrefsStore, defaultSession: Session }): SiteAsker {
  const { ctx, prefs, defaultSession } = options
  const engine = createExtensionMedia<WebContents, Place>({
    // The page may be gone by the time the person answers (an open popup closes when the sheet takes the keyboard): its session is then unreadable.
    isLoaded: (id, contents) => (contents !== null && !contents.isDestroyed() ? contents.session : defaultSession).extensions.getExtension(id) != null || defaultSession.extensions.getExtension(id) != null,
    answers: (id) => prefs.get(id).media,
    save: (id, kind, answer) => { prefs.update(id, { media: { ...prefs.get(id).media, [kind]: answer } }) },
    blockedByDefault: (kind: MediaKind) => {
      const key = siteKindById(kind)?.settingKey
      return key !== undefined && shellServices()?.settings.get(key) === 'block'
    },
    placeOf,
    ask: async (place, id, kinds) => {
      const entry = ctx.extensions?.list().find((candidate) => candidate.id === id)
      const facts = entry === undefined ? undefined : await readExtensionFacts(entry)
      return await askPermissionChoice(place.window, place.tabId, {
        extensionId: id,
        name: clipName(facts?.resolvedName ?? id),
        icon: facts?.iconDataUrl,
        lines: [],
        wants: askLines(kinds, false)[0]?.text
      })
    },
    nag: createNagLimit()
  })
  return {
    name: 'extension-media',
    request: (contents, permission, details) => engine.request(contents, permission, details),
    check: (contents, permission, requestingOrigin, details) => engine.check(contents, permission, requestingOrigin, details)
  }
}

/** Puts the asker first in the gate's registry: it must see an extension page's device request before the per-site asker, which refuses every origin that is not a website. */
export function installExtensionMedia (options: { ctx: SubsystemContext, prefs: ExtensionPrefsStore, defaultSession: Session }): void {
  siteAsks.addFirst(createExtensionMediaAsker(options))
}
