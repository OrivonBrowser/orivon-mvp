// What the Nym tunnel is doing, as the rest of the shell and the Settings page read it. Plain data.

export type NymUnavailableCause = 'not-in-build' | 'proxy' | 'other'

export type NymState =
  /** Nothing has asked for it, or it was stopped after the last app stopped using it. */
  | { readonly state: 'off' }
  /** The host runs and no app has a tunnel open. */
  | { readonly state: 'idle' }
  | { readonly state: 'connecting' }
  /** `reason` is a notice the person should read while tunnels work: the most the host keeps was reached, say. */
  | { readonly state: 'ready', readonly reason?: string }
  | { readonly state: 'failed', readonly reason: string }
  | { readonly state: 'unavailable', readonly cause: NymUnavailableCause, readonly reason: string }

/** What the Settings page's Test of Nym found. */
export type NymTestResult =
  | { readonly ok: true, readonly ms: number }
  | { readonly ok: false, readonly reason: 'unavailable' | 'failed' | 'silent', readonly detail: string }
