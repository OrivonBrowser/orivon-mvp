// The chooser: the accounts saved for the page's site, and for a sign-up form a strong password to use. It is
// Orivon's own HTML and lists usernames, never a password. A login is named by an id that must belong to the
// active tab's origin when the command runs, and the password is read in main and sent to the page's box only
// while the page is still at that origin (`fill-login.ts`). Two defs share one handler: the popup under the
// password button, which takes the keyboard, and the one under a focused box, which never does.
import { originFromUrl } from '../../broker/policy/origin.js'
import { CLOSE_LIKE_POPUP } from '../overlays/overlay-types.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { fillGenerated, fillLogin } from './fill-login.js'
import { formsFor } from './forms-registry.js'
import { generatePassword } from './generate-password.js'
import { suggestKey } from './suggest-keys.js'
import { FILL_OVERLAY, SUGGEST_OVERLAY } from './window-forms.js'

/** One row of the chooser: an id to name the login by and the username to show. Never a password. */
export interface ChooserRow { id: string, username: string }
export interface ChooserView { logins: ChooserRow[], generated: string | null, mode: 'button' | 'field' }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** A click on the popup under a box this soon after it appeared is not a choice: a page can open it under the cursor. */
export const EARLY_CLICK_MS = 500

type Choice = { kind: 'login', id: string } | { kind: 'generate' }

function chooserHandler (win: OverlayWindow, mode: ChooserView['mode']): OverlayHandler {
  const { window, services, close, send } = win
  const forms = formsFor(window, services)
  let tabId: string | null = null
  let generated: string | null = null
  let choices: Choice[] = []
  let selected = -1
  let shownAt = 0
  const activeTab = (): string | null => window.tabs.getState().activeTabId

  /** The one place a choice becomes a fill; false when the page, the tab or the store no longer allows it. */
  async function choose (choice: Choice): Promise<boolean> {
    if (tabId === null || activeTab() !== tabId) return false
    // A store that cannot keep logins, or a private window, gives nothing to a page.
    if (services.isPrivate || services.passwords.state() !== 'ready') return false
    const contents = window.tabs.liveWebContents(tabId)
    if (contents === undefined) return false
    if (choice.kind === 'login') return await fillLogin(contents, services.passwords, choice.id)
    const origin = originFromUrl(contents.mainFrame.url)
    return generated !== null && origin !== null && fillGenerated(contents, origin, generated)
  }

  async function pick (choice: Choice): Promise<boolean> {
    const tab = tabId
    const ok = await choose(choice)
    if (ok) {
      // The person has answered: the boxes they tab to next on this page are theirs to fill.
      if (tab !== null) forms.dismissChooser(tab)
      close()
    }
    return ok
  }

  const keys = (key: string): boolean => {
    const step = suggestKey(choices.length, selected, key)
    if (step.action === 'pass') return false
    if (step.action === 'dismiss') {
      if (tabId !== null) forms.dismissChooser(tabId)
      close()
      return true
    }
    if (step.action === 'move') {
      selected = step.selected
      send({ type: 'select', index: selected })
      return true
    }
    const choice = choices[selected]
    if (choice !== undefined) void pick(choice)
    return true
  }

  return {
    show: () => {
      const id = activeTab()
      if (id === null) { close(); return undefined }
      const state = forms.loginState(id)
      const logins = forms.logins(id)
      generated = state.signUp ? generatePassword() : null
      if (logins.length === 0 && generated === null) { close(); return undefined }
      tabId = id
      selected = -1
      shownAt = Date.now()
      choices = [...(generated === null ? [] : [{ kind: 'generate' } as const]), ...logins.map((login): Choice => ({ kind: 'login', id: login.id }))]
      if (mode === 'field') forms.setKeys({ tabId: id, handle: keys })
      const view: ChooserView = { logins: logins.map(({ id: loginId, username }) => ({ id: loginId, username })), generated, mode }
      return view
    },
    request: async (command) => {
      if (!isRecord(command) || tabId === null) return undefined
      if (mode === 'field' && Date.now() - shownAt < EARLY_CLICK_MS && (command['type'] === 'fill' || command['type'] === 'generate')) return { ok: false }
      switch (command['type']) {
        case 'fill': {
          const id = command['id']
          return typeof id === 'string' ? { ok: await pick({ kind: 'login', id }) } : undefined
        }
        case 'generate':
          return generated === null ? undefined : { ok: await pick({ kind: 'generate' }) }
        case 'manage':
          close()
          services.commands.run('passwords.open', window)
          return undefined
        case 'hover': {
          // Under a box, Enter is read here: the row the pointer highlighted is the one it fills.
          const index = command['index']
          if (mode === 'field' && typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < choices.length) selected = index
          return undefined
        }
        default:
          return undefined
      }
    },
    closed: (reason) => {
      if (mode === 'field') forms.setKeys(null)
      // Escape is the person saying no: the chooser does not reopen by itself for this page.
      if (reason === 'escape' && tabId !== null) forms.dismissChooser(tabId)
      tabId = null
      generated = null
      choices = []
    }
  }
}

/** The popup under the password button. */
export const passwordFillOverlay: OverlayDef = {
  name: FILL_OVERLAY,
  placement: { kind: 'anchor', width: 320, align: 'right' },
  surface: 'menu',
  focus: 'take',
  layer: 'popup',
  closeOn: CLOSE_LIKE_POPUP,
  keep: 'fresh',
  height: { initial: 120, min: 80, max: 360 },
  attach: (win) => chooserHandler(win, 'button')
}

/** The popup under a focused sign-in box: the page keeps the keyboard, and main passes the arrow keys, Enter and Escape to it. */
export const passwordSuggestOverlay: OverlayDef = {
  name: SUGGEST_OVERLAY,
  placement: { kind: 'anchor', width: 320, align: 'left' },
  surface: 'menu',
  focus: 'never',
  layer: 'popup',
  closeOn: { blur: false, tabSwitch: true, navigation: true, layout: true },
  keep: 'fresh',
  height: { initial: 120, min: 80, max: 360 },
  attach: (win) => chooserHandler(win, 'field')
}
