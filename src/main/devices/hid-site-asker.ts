// The permission gate's answer to the synchronous `hid` check (ADR-0068): may this tab's page use `navigator.hid`
// at all. It can never wait on the person, so it reads the gate and nothing else; the device permission handler and
// the chooser decide which devices. Every other permission is left to the askers and rules behind it.
import type { WebContents } from 'electron'
import { originFromUrl } from '../../broker/policy/origin.js'
import type { SiteAsker } from '../sessions/site-asks.js'

export interface HidSiteAskerDeps {
  readonly isTab: (contents: WebContents) => boolean
  readonly urlOf: (tab: WebContents) => string
  readonly mayUse: (origin: string) => boolean
}

export function createHidSiteAsker (deps: HidSiteAskerDeps): SiteAsker {
  return {
    name: 'hid',
    check (contents, permission, requestingOrigin, details) {
      if (permission !== 'hid') return undefined
      const origin = originFromUrl(requestingOrigin)
      if (origin === null) return false
      // Electron asks whether `requestDevice` may open a chooser at all with no page attached (measured), so that
      // question is answered from the origin alone; which devices, and which frame, the other gates decide.
      if (contents === null) return deps.mayUse(origin)
      if (!deps.isTab(contents)) return false
      if ((details as { isMainFrame?: unknown } | undefined)?.isMainFrame === false) return false
      // The check is about the page the person is looking at: a frame or a stale document cannot borrow its answer.
      if (origin !== originFromUrl(deps.urlOf(contents))) return false
      return deps.mayUse(origin)
    }
  }
}
