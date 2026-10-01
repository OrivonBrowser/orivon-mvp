// The sign-in sheet over a tab. The page is told what to draw and sends back one of two answers for the
// challenge main named when it showed the sheet; credentials travel from here to Electron's callback and
// nowhere else, and a saved password never reaches the page at all.
import { originFromUrl } from '../../broker/policy/origin.js'
import type { OverlayDef, OverlayHandler, OverlayWindow } from '../overlays/overlay-types.js'
import { slotClosed } from '../overlays/tab-slots.js'
import type { PasswordVault } from '../passwords/vault.js'
import { AUTH_SHEET_OVERLAY } from './auth-names.js'
import type { AuthChallenges, Challenge } from './auth-queue.js'
import { INSECURE_TEXT, lineOf, mismatchText, originOf, realmText, titleOf } from './auth-text.js'
import type { AuthView } from './auth-text.js'

/** The longest username or password the sheet takes. */
export const MAX_FIELD = 1024
const SHEET_WIDTH = 400

export interface AuthSheetDeps {
  readonly challenges: AuthChallenges
  /** A sign-in was sent from the sheet with "Remember this password": settle it once the page has loaded. */
  readonly submitted: (window: OverlayWindow['window'], vault: PasswordVault, tabId: string) => void
}

type Submit = { type: 'submit', id: string, username: string, password: string, remember: boolean, useSaved: boolean }
type Cancel = { type: 'cancel', id: string }

function asCommand (command: unknown): Submit | Cancel | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, id, username, password, remember, useSaved, ...rest } = command as Record<string, unknown>
  if (Object.keys(rest).length > 0 || typeof id !== 'string') return undefined
  if (type === 'cancel') return username === undefined && password === undefined && remember === undefined && useSaved === undefined ? { type, id } : undefined
  if (type !== 'submit' || typeof username !== 'string' || typeof password !== 'string') return undefined
  if (username.length > MAX_FIELD || password.length > MAX_FIELD) return undefined
  if ((remember !== undefined && typeof remember !== 'boolean') || (useSaved !== undefined && typeof useSaved !== 'boolean')) return undefined
  return { type, id, username, password, remember: remember === true, useSaved: useSaved === true }
}

function asId (payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { id } = payload as { id?: unknown }
  return typeof id === 'string' ? id : undefined
}

export function authSheetOverlayFor (deps: AuthSheetDeps): OverlayDef {
  return {
    name: AUTH_SHEET_OVERLAY,
    placement: { kind: 'area', at: 'center', width: SHEET_WIDTH },
    surface: 'panel',
    focus: 'take',
    layer: 'bar',
    // The question belongs to the page that asked: leaving the tab hides it and a new page ends it, but a click
    // elsewhere does not, because the person may need the page's own text to know which password to type.
    closeOn: { blur: false, tabSwitch: true, navigation: true, layout: false },
    keep: 'fresh',
    height: { min: 200, max: 460 },
    attach: createAuthSheet(deps)
  }
}

function createAuthSheet (deps: AuthSheetDeps): (win: OverlayWindow) => OverlayHandler {
  return ({ window, services, close }) => {
    /** The challenge the sheet on screen is for. */
    let shownId: string | null = null

    /** A challenge the sheet may act on: this window's, for the tab in front. */
    const current = (id: string): Challenge | undefined => {
      const challenge = deps.challenges.get(id)
      return challenge !== undefined && challenge.owner === window && window.tabs.getState().activeTabId === challenge.tabId ? challenge : undefined
    }

    const originOfRequest = (challenge: Challenge): string | undefined => {
      if (challenge.server.isProxy) return undefined
      return originFromUrl(originOf(challenge.server)) ?? undefined
    }

    /** Whether a password typed here may be kept: the vault can hold it, and the person has not turned the offer off. */
    const canRemember = (origin: string | undefined): boolean =>
      origin !== undefined && services.passwords.state() === 'ready' && services.settings.get('passwords.offerToSave')

    /** The newest login saved for this server, when the sheet may offer it: a first ask, from the page itself. */
    const savedFor = (challenge: Challenge, origin: string | undefined): { id: string, username: string } | undefined => {
      if (origin === undefined || !challenge.first || challenge.mismatch) return undefined
      if (services.passwords.state() !== 'ready' || !services.settings.get('passwords.autofill')) return undefined
      const newest = [...services.passwords.list(origin)].sort((a, b) => b.used - a.used || b.created - a.created)[0]
      return newest === undefined ? undefined : { id: newest.id, username: newest.username }
    }

    return {
      show: (payload): AuthView | undefined => {
        const id = asId(payload)
        const challenge = id === undefined ? undefined : current(id)
        if (id === undefined || challenge === undefined) { shownId = null; return undefined }
        shownId = id
        deps.challenges.shown(id)
        const origin = originOfRequest(challenge)
        const saved = savedFor(challenge, origin)
        const { server } = challenge
        return {
          id,
          title: titleOf(server),
          origin: originOf(server),
          line: lineOf(server),
          realm: realmText(server.realm),
          mismatch: challenge.mismatch ? mismatchText(server) : null,
          insecure: challenge.insecure ? INSECURE_TEXT : null,
          retry: !challenge.first,
          username: challenge.username !== '' ? challenge.username : saved?.username ?? '',
          saved: saved?.username ?? null,
          canRemember: canRemember(origin)
        }
      },
      request: async (command) => {
        const asked = asCommand(command)
        if (asked === undefined || asked.id !== shownId) return undefined
        const challenge = current(asked.id)
        if (challenge === undefined) return undefined
        if (asked.type === 'cancel') {
          deps.challenges.cancel(asked.id)
          close()
          return undefined
        }
        const origin = originOfRequest(challenge)
        let password = asked.password
        if (asked.useSaved && password === '') {
          const saved = savedFor(challenge, origin)
          if (saved === undefined || saved.username !== asked.username) return undefined
          password = await services.passwords.reveal(saved.id) ?? ''
          // The sheet may have gone while the store was being read.
          if (password === '' || shownId !== asked.id || current(asked.id) === undefined) return undefined
        }
        if (asked.username === '' && password === '') return undefined
        const remember = asked.remember && canRemember(origin)
        deps.challenges.answer(asked.id, { username: asked.username, password }, remember && origin !== undefined ? { origin } : undefined)
        if (remember) deps.submitted(window, services.passwords, challenge.tabId)
        close()
        return undefined
      },
      closed: (reason) => {
        const id = shownId
        shownId = null
        if (reason === 'tab-switch' && id !== null) deps.challenges.hidden(id)
        slotClosed(window, AUTH_SHEET_OVERLAY, reason)
      }
    }
  }
}
