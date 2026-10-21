// Transcribed from docs/architecture/capability-api.md's "v0 surface" section.
//
// app.ts - What an app can ask about itself
//
// Held in its own file so capability-api.ts stays under the source-size
// limit; `Orivon.app` there is the only member that points here.

import type { Grant, Manifest, Pattern } from './manifest.js'

export interface OrivonApp {
  manifest(): Promise<Manifest>
  /** What was ACTUALLY granted, which is a subset of what the manifest declares. */
  grants(): Promise<readonly Grant[]>
  /** May prompt the user. Resolves false if declined or not declared. */
  requestGrant(capability: CapabilityRequest): Promise<boolean>
  /**
   * Hears each link the person sent to THIS app: a URL whose scheme the
   * manifest declares in `protocols` and that the person chose to open here.
   * Every URL is delivered as the shell received it, after the shell checked
   * it against that scheme's grammar and the length bound; the app still
   * treats the string as untrusted input. The listener runs once per URL.
   *
   * URLs routed before the page registers a listener (the app was not open)
   * wait, and reach the first listener that registers, in the order they
   * were routed. A reload or a second listener does not deliver a URL again.
   * Returns a function that removes this listener.
   */
  onOpenUrl(listener: (url: string) => void): () => void
  /**
   * Asks the person to make this app the default for `scheme`, so a link of
   * that scheme opens here without the question each time. Needs transient
   * user activation (a click or a key press in the page). Resolves true when
   * the app is the default afterwards, which includes the person already
   * having chosen it, and false when the person declined, when `scheme` is
   * not in the manifest's `protocols`, or when it is a scheme Orivon never
   * routes to an app (`http`, `https`, `file`, `javascript`, `orivon*`).
   * Rejects `'invalid'` for a value that is not a scheme name.
   */
  requestSchemeHandler(scheme: string): Promise<boolean>
  /** Whether the person has chosen this app as the default for `scheme`. False for a scheme the manifest does not declare. */
  isSchemeHandler(scheme: string): Promise<boolean>
}

export interface CapabilityRequest {
  readonly capability: string
  readonly patterns?: readonly Pattern[]
}
