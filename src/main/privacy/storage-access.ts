// `storage-access` and `top-level-storage-access`: a frame asking to read its
// own cookies while embedded. Answered by the cookie choice and never by a
// prompt: with all cookies allowed the grant gives the page nothing it lacks,
// and with third-party cookies blocked the answer is no. Only a tab is
// answered; any other context keeps the permission gate's own rules.
import type { WebContents } from 'electron'
import type { SiteAsker } from '../sessions/site-asks.js'

export const STORAGE_ACCESS_PERMISSIONS: ReadonlySet<string> = new Set(['storage-access', 'top-level-storage-access'])

export interface StorageAccessDeps {
  readonly blocking: () => boolean
  readonly isTab: (contents: WebContents) => boolean
}

export function createStorageAccessAsker ({ blocking, isTab }: StorageAccessDeps): SiteAsker {
  return {
    name: 'storage-access',
    request: (contents, permission) => {
      if (!STORAGE_ACCESS_PERMISSIONS.has(permission) || !isTab(contents)) return undefined
      return Promise.resolve(!blocking())
    },
    check: (contents, permission) => {
      if (!STORAGE_ACCESS_PERMISSIONS.has(permission) || contents === null || !isTab(contents)) return undefined
      return !blocking()
    }
  }
}
