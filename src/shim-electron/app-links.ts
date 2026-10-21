// The part of Electron's `app` that is about links: which program opens a scheme (`setAsDefaultProtocolClient`) and
// the `open-url` event. In Orivon "which program" is "which app", and it is the person's choice: `orivon.app` asks them
// (`requestSchemeHandler`) and delivers what they sent here (`onOpenUrl`). Operating-system registration, so that a
// link clicked in another program opens an app, stays unbuilt (ADR-0072), and so do the other `app` events.

import { refuse } from './errors.js'
import type { Orivon } from '../contracts/capability-api.js'

/** What `open-url` listeners receive first, as far as an Orivon app can use it: Electron's `Event`, whose default action is the system's, and there is none to stop. */
export interface OpenUrlEvent {
  readonly defaultPrevented: boolean
  preventDefault: () => void
}

export type OpenUrlListener = (event: OpenUrlEvent, url: string) => void

export interface ElectronAppLinks {
  /**
   * Electron answers whether the system accepted the registration, at once. Here the person decides, later, so this
   * answers `true` only when the app already is the default and otherwise `false` while it asks them; once they
   * agree, `isDefaultProtocolClient` reads `true`. It asks only for a scheme the manifest lists in `protocols`, and
   * only while the page has a click or key press behind it.
   */
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: readonly string[]): boolean
  /** Always `false`: an app cannot take itself back out. The person does that in Settings, under Apps. */
  removeAsDefaultProtocolClient(protocol: string, path?: string, args?: readonly string[]): boolean
  /** As of `whenReady()` and this app's own requests since; a change the person makes in Settings is read the next time the app starts. */
  isDefaultProtocolClient(protocol: string, path?: string, args?: readonly string[]): boolean
  on(event: 'open-url', listener: OpenUrlListener): ElectronAppLinks
  once(event: 'open-url', listener: OpenUrlListener): ElectronAppLinks
  addListener(event: 'open-url', listener: OpenUrlListener): ElectronAppLinks
  off(event: 'open-url', listener: OpenUrlListener): ElectronAppLinks
  removeListener(event: 'open-url', listener: OpenUrlListener): ElectronAppLinks
  removeAllListeners(event?: 'open-url'): ElectronAppLinks
}

interface Registered { readonly listener: OpenUrlListener, readonly wrapper: OpenUrlListener }

export interface LinkDeps {
  readonly orivon: Pick<Orivon, 'app'>
  /** The schemes the manifest lists, once `whenReady()` has fetched it. */
  readonly declared: (api: string) => readonly string[]
  readonly warn: (message: string, error: unknown) => void
}

/** Starts as `whenReady()` finishes: the schemes this app already is the default for. */
export async function currentDefaults (orivon: Pick<Orivon, 'app'>, schemes: readonly string[]): Promise<Set<string>> {
  const held = new Set<string>()
  await Promise.all(schemes.map(async (scheme) => {
    try {
      if (await orivon.app.isSchemeHandler(scheme)) held.add(scheme)
    } catch {
      // Not a default as far as the app can tell.
    }
  }))
  return held
}

function onlyOpenUrl (api: string, event: string): void {
  if (event === 'open-url') return
  throw refuse(`app.${api}('${event}')`, 'unimplemented',
    `app.${api}('${event}') is not implemented: the 'open-url' event is the only app event Orivon delivers, ` +
    `because it is the only one a person can cause in a browser (a link they sent to this app).`)
}

/** `self` is the object the methods are on, which every chainable one returns, as Electron's `app` does. */
export function createAppLinks (deps: LinkDeps, defaults: () => Set<string>, self: () => ElectronAppLinks): ElectronAppLinks {
  const registered: Registered[] = []
  let stop: (() => void) | undefined

  function hear (url: string): void {
    for (const { wrapper } of [...registered]) {
      let prevented = false
      const event: OpenUrlEvent = { get defaultPrevented () { return prevented }, preventDefault: () => { prevented = true } }
      try { wrapper(event, url) } catch (error) { deps.warn("an app.on('open-url') listener threw", error) }
    }
  }

  function add (listener: OpenUrlListener, once: boolean): void {
    const wrapper: OpenUrlListener = once
      ? (event, url) => { remove(listener); listener(event, url) }
      : listener
    registered.push({ listener, wrapper })
    // The page starts hearing links, and any that were held for it arrive, only when something listens.
    stop ??= deps.orivon.app.onOpenUrl(hear)
  }

  function remove (listener: OpenUrlListener): void {
    const index = registered.findIndex((entry) => entry.listener === listener)
    if (index >= 0) registered.splice(index, 1)
    if (registered.length === 0 && stop !== undefined) {
      stop()
      stop = undefined
    }
  }

  return {
    setAsDefaultProtocolClient: (protocol) => {
      const scheme = String(protocol).toLowerCase()
      if (!deps.declared('app.setAsDefaultProtocolClient').includes(scheme)) return false
      if (defaults().has(scheme)) return true
      void deps.orivon.app.requestSchemeHandler(scheme).then((agreed) => { if (agreed) defaults().add(scheme) }).catch(() => {})
      return false
    },
    removeAsDefaultProtocolClient: () => false,
    isDefaultProtocolClient: (protocol) => {
      deps.declared('app.isDefaultProtocolClient')
      return defaults().has(String(protocol).toLowerCase())
    },
    on: (event, listener) => { onlyOpenUrl('on', event); add(listener, false); return self() },
    addListener: (event, listener) => { onlyOpenUrl('addListener', event); add(listener, false); return self() },
    once: (event, listener) => { onlyOpenUrl('once', event); add(listener, true); return self() },
    off: (event, listener) => { onlyOpenUrl('off', event); remove(listener); return self() },
    removeListener: (event, listener) => { onlyOpenUrl('removeListener', event); remove(listener); return self() },
    removeAllListeners: (event) => {
      if (event !== undefined) onlyOpenUrl('removeAllListeners', event)
      for (const { listener } of [...registered]) remove(listener)
      return self()
    }
  }
}
