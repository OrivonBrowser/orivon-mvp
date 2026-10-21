// A link of a scheme some app declares can open in that app (d-0596). This joins the choice the person made, the
// apps that may take a link, the queue each app's page reads from, and the questions: `routing` is what the
// external-link gate calls, `host` is what an app's own calls (`orivon.app.onOpenUrl`, `requestSchemeHandler`)
// reach through the broker's control channel. No `electron` import: the shell supplies the tab and the questions.
import { askableScheme, isHandableScheme, MAX_ROUTED_URL_LENGTH, type AppLinkOption, type LinkAnswer, type LinkRouting } from '../sessions/external-links.js'
import { tabPromptState, type PromptingTab, type TabPromptState } from '../sessions/tab-prompts.js'
import type { AppDirectory } from './app-directory.js'
import type { OpenUrlQueue } from './open-url-queue.js'
import type { SchemeChoices } from './scheme-choices.js'

/** How long one wait for the next link lasts before the page asks again: under the preload's call budget, so the answer is always ours. */
export const OPEN_URL_POLL_MS = 25_000

export interface SchemeRoutingDeps<W> {
  readonly apps: AppDirectory
  readonly choices: SchemeChoices
  readonly queue: OpenUrlQueue
  /** Draws "which app should open this link". */
  readonly chooseApp: (window: W, question: Parameters<LinkRouting<W>['choose']>[1], apps: readonly AppLinkOption[], tab: PromptingTab) => Promise<LinkAnswer>
  /** Draws "make this app your default". True only when the person agreed. */
  readonly confirmDefault: (tab: PromptingTab, question: { scheme: string, origin: string, replaces?: string | undefined }) => Promise<boolean>
  /** Shows the app's tab in front, opening one when it has none. */
  readonly showApp: (origin: string, from: PromptingTab | undefined) => void
}

/** The tab that sent a control call, as far as the wait for a link reads it. */
interface AskingPage {
  on?: (event: 'did-start-navigation', listener: (details: { isMainFrame?: boolean, isSameDocument?: boolean }) => void) => unknown
  once?: (event: 'destroyed', listener: () => void) => unknown
  removeListener?: (event: 'did-start-navigation' | 'destroyed', listener: (...args: never[]) => void) => unknown
}

/** What the control channel reaches (`src/broker/transport/ipc-validation.ts`'s `SchemeCtx`, structurally). */
export interface SchemeHost {
  nextUrl: (origin: string, abandoned: AbortSignal, contents: unknown) => Promise<string | null>
  requestHandler: (origin: string, scheme: string, caller: { readonly contents?: (() => unknown) | undefined }) => Promise<boolean>
  isHandler: (origin: string, scheme: string) => Promise<boolean>
}

export function createSchemeRouting<W> (deps: SchemeRoutingDeps<W>): { routing: LinkRouting<W>, host: SchemeHost } {
  const { apps, choices, queue } = deps

  const routing: LinkRouting<W> = {
    appsFor: async (scheme) => await apps.appsFor(scheme),
    defaultAmong: (scheme, among) => {
      const chosen = choices.get(scheme)
      return chosen !== undefined && among.some((app) => app.origin === chosen) ? chosen : undefined
    },
    choose: async (window, question, among, tab) => await deps.chooseApp(window, question, among, tab),
    remember: (scheme, origin) => { choices.set(scheme, origin) },
    open: (origin, url, from) => {
      const scheme = askableScheme(url)
      if (scheme === null || url.length > MAX_ROUTED_URL_LENGTH) return
      // Checked again here, at the moment of delivery: the answer was read before the person decided.
      void apps.appAt(origin, scheme).then((app) => {
        if (app === undefined) return
        queue.push(origin, url)
        deps.showApp(origin, from)
      }).catch(() => {})
    }
  }

  const host: SchemeHost = {
    nextUrl: async (origin, abandoned, contents) => {
      const page = contents as AskingPage | undefined
      const gone = new AbortController()
      const leave = (): void => { gone.abort() }
      const leaves = (details: { isMainFrame?: boolean, isSameDocument?: boolean }): void => { if (details.isMainFrame === true && details.isSameDocument !== true) leave() }
      abandoned.addEventListener('abort', leave)
      if (abandoned.aborted) leave()
      page?.on?.('did-start-navigation', leaves)
      page?.once?.('destroyed', leave)
      try {
        return await queue.next(origin, OPEN_URL_POLL_MS, gone.signal)
      } finally {
        abandoned.removeEventListener('abort', leave)
        page?.removeListener?.('did-start-navigation', leaves)
        page?.removeListener?.('destroyed', leave)
      }
    },
    isHandler: async (origin, scheme) => choices.get(scheme) === origin && await apps.appAt(origin, scheme) !== undefined,
    requestHandler: async (origin, scheme, caller) => {
      const app = await apps.appAt(origin, scheme)
      if (app === undefined || !isHandableScheme(scheme)) return false
      const current = choices.get(scheme)
      if (current === origin) return true
      const tab = caller.contents?.() as (PromptingTab & { isDestroyed?: () => boolean }) | undefined
      if (tab === undefined || tab.isDestroyed?.() === true) return false
      const state: TabPromptState = tabPromptState(tab)
      if (state.prompting) return false
      state.prompting = true
      try {
        const agreed = await deps.confirmDefault(tab, { scheme, origin, replaces: current })
        if (agreed) choices.set(scheme, origin)
        return agreed
      } catch {
        return false
      } finally {
        state.prompting = false
      }
    }
  }

  return { routing, host }
}
