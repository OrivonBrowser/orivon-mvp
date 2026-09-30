// What one window knows about the sign-in forms of its tabs: which tab has a password field, which
// credential a tab just submitted and whether it is worth offering to keep, and what the password button
// and the chooser may show. Decisions are in `save-offer.ts`; this holds the state and runs the timers.
// No `electron` import: the watcher's messages, the vault, settings and the overlay slot come in as
// dependencies, so the rules are tested with fakes.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { OverlayAnchor } from '../overlays/overlay-types.js'
import type { SlotAsk } from '../overlays/tab-slots.js'
import type { ShellWindow } from '../shell/window-registry.js'
import type { FieldRect, FormCommand, FormConfig, FormMessage } from './form-message.js'
import type { FormSender } from './form-watch-ipc.js'
import { classify, judge, KEEP_MS, QUIET_MS, SUCCESS_WINDOW_MS } from './save-offer.js'
import type { Navigation, Observed, OfferKind, PendingCredential } from './save-offer.js'
import type { Login, PasswordVault } from './vault.js'

export const SAVE_OVERLAY = 'password-save'
export const FILL_OVERLAY = 'password-fill'
export const SUGGEST_OVERLAY = 'password-suggest'
const MAX_NAVIGATIONS = 8

export interface FormsDeps {
  readonly vault: PasswordVault
  readonly settings: { get: (key: 'passwords.offerToSave' | 'passwords.autofill') => boolean }
  /** This process is a private session: nothing is offered and nothing is kept. */
  readonly isPrivate: boolean
  /** A registered app's tab runs its own sign-in; the watcher stays out of it. */
  readonly isAppTab: (tabId: string) => boolean
  readonly now: () => number
  readonly schedule: (run: () => void, ms: number) => () => void
  readonly requestSlot: (ask: SlotAsk) => { cancel: () => void }
  readonly anchor: () => OverlayAnchor | undefined
  readonly send: (contents: WebContents, origin: string, command: FormCommand) => boolean
  readonly liveContents: (tabId: string) => WebContents | undefined
  /** Whether the tab is the one in front: only that tab's box may open a chooser. */
  readonly isActive: (tabId: string) => boolean
  /** Shows the chooser under the box the page reported; the tab's own place is the registry's to know. */
  readonly openSuggest: (tabId: string, field: FocusedField) => void
  readonly closeSuggest: () => void
}

/** What the chrome draws from: how many logins the page's sign-in form could use, and whether an offer to keep one is waiting. */
export interface LoginState { count: number, offer: boolean, signUp: boolean }
export const NO_LOGINS: LoginState = { count: 0, offer: false, signUp: false }

/** What the save prompt shows of the pending credential: never the password itself. */
export interface OfferView { kind: 'save' | 'update', origin: string, username: string }

/** Where the field the person focused is, in the tab's own pixels, and how wide the page was when it said so. */
export interface FocusedField { rect: FieldRect, viewWidth: number, signUp: boolean }

interface Pending {
  readonly credential: PendingCredential
  kind: Exclude<OfferKind, 'none'> | null
  login: Login | undefined
  ask: { cancel: () => void } | undefined
  classifying: boolean
  readonly timers: Array<() => void>
}

interface TabForms {
  origin: string | null
  hasPassword: boolean
  signUp: boolean
  fields: Observed['fields']
  navigations: Navigation[]
  pending: Pending | null
  /** The chooser was closed with Escape: it does not open by itself again until the page loads anew. */
  chooserDismissed: boolean
  focused: FocusedField | null
}

/** Who reads the keys while the chooser under a box is open: it never has the keyboard, so main offers each key first. */
export interface KeyHandler { readonly tabId: string, handle: (key: string) => boolean }

export interface WindowForms {
  config: (tabId: string, origin: string) => FormConfig
  hello: (sender: FormSender) => void
  fields: (sender: FormSender, message: Extract<FormMessage, { type: 'fields' }>) => void
  focus: (sender: FormSender, message: Extract<FormMessage, { type: 'focus' }>) => void
  /** The box the chooser hung from lost focus. */
  blur: (sender: FormSender) => void
  setKeys: (handler: KeyHandler | null) => void
  /** Whether the chooser under a box took this key of this tab; the key then never reaches the page. */
  keyFor: (tabId: string, key: string) => boolean
  submit: (sender: FormSender, message: Extract<FormMessage, { type: 'submit' }>) => void
  navigated: (tabId: string, navigation: Omit<Navigation, 'at'>) => void
  tabGone: (tabId: string) => void
  /** The settings or the vault changed: every tab's watcher is told what it may do now. */
  configChanged: () => void
  loginState: (tabId: string | null) => LoginState
  logins: (tabId: string) => Login[]
  focusedField: (tabId: string) => FocusedField | null
  chooserWanted: (tabId: string) => boolean
  dismissChooser: (tabId: string) => void
  /** The pending offer of a tab, once it is worth showing. */
  offerFor: (tabId: string) => OfferView | undefined
  save: (tabId: string, username: string) => Promise<boolean>
  never: (tabId: string) => void
  /** "Not now": the offer is over. */
  decline: (tabId: string) => void
  reveal: (tabId: string) => string | undefined
  /** The password button: shows the prompt of a waiting offer again. False when there is none. */
  reopenOffer: (tabId: string) => boolean
  onChange: (listener: () => void) => () => void
}

export function createWindowForms (window: ShellWindow, deps: FormsDeps): WindowForms {
  const tabs = new Map<string, TabForms>()
  const listeners = new Set<() => void>()
  const notify = (): void => { for (const listener of [...listeners]) listener() }
  let keys: KeyHandler | null = null

  const ready = (): boolean => !deps.isPrivate && deps.vault.state() === 'ready'

  function tabOf (tabId: string, origin: string | null = null): TabForms {
    let tab = tabs.get(tabId)
    if (tab === undefined) {
      tab = { origin, hasPassword: false, signUp: false, fields: null, navigations: [], pending: null, chooserDismissed: false, focused: null }
      tabs.set(tabId, tab)
    }
    return tab
  }

  function configFor (tabId: string, origin: string): FormConfig {
    const save = deps.settings.get('passwords.offerToSave')
    const autofill = deps.settings.get('passwords.autofill')
    const on = ready() && (save || autofill) && !deps.isAppTab(tabId)
    return { enabled: on, save: on && save && !deps.vault.never.has(origin), autofill: on && autofill }
  }

  function sendConfig (tabId: string, contents: WebContents, origin: string): void {
    deps.send(contents, origin, { type: 'config', ...configFor(tabId, origin) })
  }

  function clearPending (tab: TabForms): void {
    const pending = tab.pending
    if (pending === null) return
    tab.pending = null
    for (const cancel of pending.timers) cancel()
    pending.ask?.cancel()
  }

  function observed (tab: TabForms): Observed {
    return { navigations: tab.navigations, fields: tab.fields }
  }

  /** Asks the slot for the save prompt; the prompt may go away on its own and the credential stays for the button. */
  function present (tabId: string, pending: Pending): void {
    pending.ask?.cancel()
    let ended = false
    const ask = deps.requestSlot({
      window,
      tabId,
      slot: 'address',
      overlay: SAVE_OVERLAY,
      payload: { tabId },
      anchor: deps.anchor,
      // An ask the slot refuses ends before `requestSlot` returns, so it must not be kept as live.
      closed: () => { ended = true; pending.ask = undefined }
    })
    if (!ended) pending.ask = ask
  }

  async function evaluate (tabId: string, pending: Pending): Promise<void> {
    const tab = tabs.get(tabId)
    if (tab === undefined || tab.pending !== pending) return
    // Once shown, only the clock ends an offer; the page has already proved the sign-in worked.
    if (pending.kind !== null) {
      if (deps.now() - pending.credential.at > KEEP_MS) { clearPending(tab); notify() }
      return
    }
    if (pending.classifying) return
    const verdict = judge(pending.credential, observed(tab), deps.now())
    if (verdict === 'wait') return
    if (verdict === 'drop') { clearPending(tab); notify(); return }
    pending.classifying = true
    const { kind, login } = await classify(deps.vault, pending.credential)
    pending.classifying = false
    if (tab.pending !== pending) return
    if (kind === 'none') { clearPending(tab); notify(); return }
    pending.kind = kind
    pending.login = login
    present(tabId, pending)
    notify()
  }

  function track (tabId: string, pending: Pending): void {
    const run = (): void => { void evaluate(tabId, pending) }
    pending.timers.push(
      deps.schedule(run, QUIET_MS),
      deps.schedule(run, SUCCESS_WINDOW_MS + 1),
      deps.schedule(run, KEEP_MS + 1)
    )
  }

  /** A chooser opens under a focused sign-in box when the site has logins to offer, or the form is a sign-up, and the person has not said no to it on this page. */
  function wantsSuggest (tabId: string, tab: TabForms): boolean {
    if (!ready() || tab.origin === null || tab.chooserDismissed) return false
    if (!deps.settings.get('passwords.autofill') || deps.isAppTab(tabId) || !deps.isActive(tabId)) return false
    return tab.signUp || deps.vault.list(tab.origin).length > 0
  }

  function broadcast (): void {
    for (const [tabId, tab] of tabs) {
      const contents = deps.liveContents(tabId)
      const origin = contents === undefined ? null : originFromUrl(contents.mainFrame.url)
      if (contents !== undefined && origin !== null) sendConfig(tabId, contents, origin)
      // With the feature off nothing is kept waiting.
      if (!ready() || !deps.settings.get('passwords.offerToSave')) clearPending(tab)
    }
    notify()
  }

  const pendingOf = (tabId: string): Pending | undefined => {
    const pending = tabs.get(tabId)?.pending
    return pending === null || pending === undefined || pending.kind === null ? undefined : pending
  }

  return {
    config: configFor,

    hello (sender) {
      const tab = tabOf(sender.tabId, sender.origin)
      // A new document: what the last one said about its fields is gone.
      tab.origin = sender.origin
      tab.hasPassword = false
      tab.signUp = false
      tab.fields = null
      sendConfig(sender.tabId, sender.contents, sender.origin)
      notify()
    },

    fields (sender, message) {
      const tab = tabOf(sender.tabId, sender.origin)
      tab.origin = sender.origin
      tab.hasPassword = message.hasPassword
      tab.signUp = message.signUp
      tab.fields = { hasPassword: message.hasPassword, at: deps.now() }
      const pending = tab.pending
      if (pending !== null) void evaluate(sender.tabId, pending)
      notify()
    },

    focus (sender, message) {
      const tab = tabOf(sender.tabId, sender.origin)
      tab.focused = { rect: message.rect, viewWidth: message.viewWidth, signUp: message.signUp }
      tab.signUp = message.signUp
      tab.hasPassword = true
      if (wantsSuggest(sender.tabId, tab)) deps.openSuggest(sender.tabId, tab.focused)
      notify()
    },

    blur () {
      deps.closeSuggest()
    },

    setKeys: (handler) => { keys = handler },

    keyFor: (tabId, key) => keys !== null && keys.tabId === tabId && keys.handle(key),

    submit (sender, message) {
      const config = configFor(sender.tabId, sender.origin)
      if (!config.save) return
      const tab = tabOf(sender.tabId, sender.origin)
      clearPending(tab)
      const pending: Pending = {
        credential: { origin: sender.origin, username: message.username, password: message.password, at: deps.now() },
        kind: null, login: undefined, ask: undefined, classifying: false, timers: []
      }
      tab.pending = pending
      track(sender.tabId, pending)
      void evaluate(sender.tabId, pending)
    },

    navigated (tabId, navigation) {
      const tab = tabOf(tabId)
      tab.navigations.push({ ...navigation, at: deps.now() })
      if (tab.navigations.length > MAX_NAVIGATIONS) tab.navigations.shift()
      if (!navigation.inPage) {
        tab.origin = navigation.origin
        tab.hasPassword = false
        tab.signUp = false
        tab.fields = null
        tab.focused = null
        tab.chooserDismissed = false
      }
      const pending = tab.pending
      if (pending !== null) {
        // A shown offer goes when the tab leaves the site it was made for.
        if (pending.kind !== null && navigation.origin !== pending.credential.origin) clearPending(tab)
        else void evaluate(tabId, pending)
      }
      notify()
    },

    tabGone (tabId) {
      const tab = tabs.get(tabId)
      if (tab === undefined) return
      clearPending(tab)
      tabs.delete(tabId)
      notify()
    },

    configChanged: broadcast,

    loginState (tabId) {
      const tab = tabId === null ? undefined : tabs.get(tabId)
      if (tabId === null || tab === undefined || !ready()) return NO_LOGINS
      const offer = tab.pending?.kind != null && deps.settings.get('passwords.offerToSave')
      const fill = tab.hasPassword && tab.origin !== null && deps.settings.get('passwords.autofill') && !deps.isAppTab(tabId)
      return {
        count: fill ? deps.vault.list(tab.origin as string).length : 0,
        offer,
        signUp: fill && tab.signUp
      }
    },

    logins (tabId) {
      const origin = tabs.get(tabId)?.origin
      if (origin === null || origin === undefined || !ready()) return []
      return [...deps.vault.list(origin)].sort((a, b) => b.used - a.used || b.created - a.created)
    },

    focusedField: (tabId) => tabs.get(tabId)?.focused ?? null,

    chooserWanted: (tabId) => {
      const tab = tabs.get(tabId)
      return tab !== undefined && !tab.chooserDismissed && deps.settings.get('passwords.autofill')
    },

    dismissChooser (tabId) {
      const tab = tabs.get(tabId)
      if (tab !== undefined) tab.chooserDismissed = true
    },

    offerFor (tabId) {
      const pending = pendingOf(tabId)
      if (pending === undefined || pending.kind === null) return undefined
      return { kind: pending.kind, origin: pending.credential.origin, username: pending.login?.username ?? pending.credential.username }
    },

    async save (tabId, username) {
      const pending = pendingOf(tabId)
      if (pending === undefined || !ready()) return false
      const name = pending.kind === 'update' ? pending.login?.username ?? pending.credential.username : username
      const saved = await deps.vault.save({ origin: pending.credential.origin, username: name, password: pending.credential.password })
      if (saved === null) return false
      const tab = tabs.get(tabId)
      if (tab?.pending === pending) {
        tab.pending = null
        for (const cancel of pending.timers) cancel()
      }
      notify()
      return true
    },

    never (tabId) {
      const pending = pendingOf(tabId)
      if (pending === undefined) return
      deps.vault.never.add(pending.credential.origin)
      const tab = tabs.get(tabId)
      if (tab !== undefined) clearPending(tab)
      broadcast()
    },

    decline (tabId) {
      const tab = tabs.get(tabId)
      if (tab === undefined) return
      clearPending(tab)
      notify()
    },

    reveal: (tabId) => pendingOf(tabId)?.credential.password,

    reopenOffer (tabId) {
      const pending = pendingOf(tabId)
      if (pending === undefined) return false
      if (pending.ask === undefined) present(tabId, pending)
      return true
    },

    onChange (listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
