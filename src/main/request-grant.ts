// OrivonApp.requestGrant's mechanism (contracts/capability-api.ts) -- the
// first production caller of broker.grant() (docs/planning/
// unattended-build-queue.md item 4.1; compatibility-matrix.md Table 4 row
// 1: "no grant exists in production"). Transport-agnostic on purpose: this
// module has no Electron import and no IPC of its own, the same reason
// app-install.ts and dev-grant.ts stay thin glue over ../broker/broker-
// contracts.js -- whatever wires window.orivon.app.requestGrant to a real
// page (a control-channel case, ../broker/transport/ipc.ts) is free to call
// this function directly, passing the ORIGIN IT DERIVED from the sender
// frame (T3), never one read out of the request payload.
//
// The three security properties item 4.1 names, and where each is enforced:
//   1. never exceeds the manifest      -- decideGrantRequest (../broker/
//      policy/request-grant.ts), called BEFORE any prompt.
//   2. the origin is the broker's      -- `origin` is a parameter here, the
//      same shape every other Broker method already takes; this file never
//      reads one out of `request`.
//   3. persistence mints no authority  -- see ./request-grant-prompt.ts's
//      header for what is trusted on the read-back path; this file never
//      reads a grant back, only ever writes one forward via broker.grant().

import { decideGrantRequest, isCapabilityKind } from '../broker/policy/request-grant.js'
import type { Broker } from '../broker/broker-contracts.js'
import type { CapabilityRequest, Pattern, CapabilityKind } from '../contracts/index.js'

/**
 * Asks a person whether `origin` may hold `capability` over `patterns` --
 * ALREADY NARROWED to what the manifest declares (decideGrantRequest ran
 * first, in `requestGrant` below, before this is ever called) -- never the
 * app's raw, unchecked request. This is the ONLY seam item 4.2's real
 * prompt (breadth visible, a rendered manifest) needs to replace; nothing
 * about `requestGrant`'s own logic changes when it does.
 */
export type ConsentPrompt = (origin: string, capability: CapabilityKind, patterns: readonly Pattern[]) => Promise<boolean>

/**
 * OrivonApp.requestGrant's full contract (capability-api.ts): "May prompt
 * the user. Resolves false if declined or not declared."
 *
 * `request.capability` is typed as a bare `string` at the contract layer
 * (an app is untrusted input), so an unrecognised value is treated exactly
 * like "not declared" -- resolved false, no prompt, matching the same
 * fail-closed stance `decideGrantRequest` takes for a real CapabilityKind
 * the manifest never named.
 *
 * A MISSING MANIFEST (no `registerApp` ever ran for `origin`) also resolves
 * false rather than throwing: `broker.app.manifest` rejects 'internal' for
 * that case (a broker fault from ITS perspective -- every other caller is
 * expected to have registered first), but from a requester's point of view
 * "nothing was ever declared" and "not declared" are the same fact.
 */
export async function requestGrant (
  broker: Broker,
  consent: ConsentPrompt,
  origin: string,
  request: CapabilityRequest
): Promise<boolean> {
  if (!isCapabilityKind(request.capability)) return false

  let manifest
  try {
    manifest = await broker.app.manifest(origin)
  } catch {
    return false
  }

  const decision = decideGrantRequest(manifest, request.capability, request.patterns)
  if (!decision.allowed) return false

  const accepted = await consent(origin, request.capability, decision.patterns)
  if (!accepted) return false

  await broker.grant(origin, request.capability, decision.patterns)
  return true
}
