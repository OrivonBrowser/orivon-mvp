// What the Settings page may ask about the new tab's picture: to choose one. The page never sends a path; the
// picker opens in main, and what it returns goes straight to the store.
import type { WebContents } from 'electron'
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { BackgroundStore } from './background-store.js'

export interface BackgroundHost {
  /** Opens the file picker over the window holding `contents`; undefined when the person cancels. */
  pick: (contents: WebContents) => Promise<string | undefined>
}

export type ChooseReply =
  | { readonly ok: true }
  | { readonly ok: false, readonly cancelled: true }
  | { readonly ok: false, readonly reason: string }

export function backgroundDomain (store: Pick<BackgroundStore, 'install'>, host: BackgroundHost): InternalDomain {
  // A second click while the picker is open would stack a second picker.
  let choosing = false
  return {
    pages: ['settings'],
    handle: async (command, caller): Promise<ChooseReply | undefined> => {
      if (typeof command !== 'object' || command === null || (command as { type?: unknown }).type !== 'choose') return undefined
      if (choosing) return { ok: false, cancelled: true }
      choosing = true
      try {
        const path = await host.pick(caller.contents)
        return path === undefined ? { ok: false, cancelled: true } : store.install(path)
      } finally {
        choosing = false
      }
    }
  }
}
