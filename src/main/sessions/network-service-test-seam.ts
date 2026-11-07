// Test builds only: what the network service's restart did, for an end-to-end test that cannot read Chromium's resolver
// or the certificate check it set. Gated on the same compiled-in flag as ../dev/dev-grant.ts, so an ordinary build
// carries none of it (scripts/check-dev-grant-absent.mjs looks for __orivonDevNetworkService in the output).

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

export interface NetworkServiceSeam {
  /** Times the service ended. */
  ended: number
  /** Times its settings were sent again to the running service. */
  resent: number
  /** Every call that set the host resolver, in order, with the mode it set. */
  resolverCalls: Array<{ readonly at: number, readonly mode: string | undefined, readonly servers: number }>
  /** Every certificate check bound to a session, in order: the number of sessions it covered. */
  certificateChecks: number[]
  /** How each hold ended, in order. */
  holds: Array<{ readonly outcome: string, readonly requests: number }>
}

declare global {
  var __orivonDevNetworkService: NetworkServiceSeam | undefined
}

function seam (): NetworkServiceSeam | undefined {
  if (!SEAM_ENABLED) return undefined
  globalThis.__orivonDevNetworkService ??= { ended: 0, resent: 0, resolverCalls: [], certificateChecks: [], holds: [] }
  return globalThis.__orivonDevNetworkService
}

export function noteServiceEnded (): void {
  const state = seam()
  if (state !== undefined) state.ended += 1
}

export function noteSettingsResent (): void {
  const state = seam()
  if (state !== undefined) state.resent += 1
}

export function noteResolverCall (options: { readonly secureDnsMode?: string | undefined, readonly secureDnsServers?: readonly string[] | undefined }): void {
  seam()?.resolverCalls.push({ at: Date.now(), mode: options.secureDnsMode, servers: options.secureDnsServers?.length ?? 0 })
}

export function noteHoldEnded (report: { readonly outcome: string, readonly requests: number }): void {
  seam()?.holds.push({ outcome: report.outcome, requests: report.requests })
}

export function noteCertificateChecks (sessions: number): void {
  seam()?.certificateChecks.push(sessions)
}

const positive = (value: string | undefined): number | undefined => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** Test builds only: how long the settings are held back after the new service answers, so a suite can start a request inside the hold. Zero in an ordinary build. */
export function reapplyDelayMs (): number {
  return SEAM_ENABLED ? positive(process.env['ORIVON_TEST_NETWORK_SERVICE_REAPPLY_DELAY_MS']) ?? 0 : 0
}

/** Test builds only: the bound a suite asked for on how long requests wait, or undefined for the ordinary one. */
export function holdBoundOverrideMs (): number | undefined {
  return SEAM_ENABLED ? positive(process.env['ORIVON_TEST_NETWORK_SERVICE_HOLD_BOUND_MS']) : undefined
}
