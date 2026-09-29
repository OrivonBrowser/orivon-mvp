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

import { decideGrantRequest, isCapabilityKind } from '../../broker/policy/request-grant.js'
import type { Broker } from '../../broker/broker-contracts.js'
import type { CapabilityRequest, Pattern, CapabilityKind } from '../../contracts/index.js'

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
 * One in-flight `requestGrant` call per (origin, capability): a second call
 * for the same pair, made while the first is still awaiting its `consent`
 * dialog (or anything before it), shares that first call's eventual answer
 * instead of opening a second dialog. Keyed narrower than plan decision 10's
 * own wording ("one pending prompt per origin") on purpose: two DIFFERENT
 * capabilities requested concurrently for one origin are two different
 * questions, and applying one's answer to the other would be a correctness
 * bug (grant `fs` because `tcp.connect` happened to be approved, or the
 * reverse), not a UX nicety -- a burst of calls all asking for the SAME
 * capability, in a loop or all at once, is what this still fully closes.
 *
 * A `Map`, not a `WeakMap`: the key is a string, not an object, and entries
 * are removed (see `requestGrant` below) the instant their call settles, so
 * nothing here outlives the request it was made for.
 */
export type PendingGrantRequests = Map<string, Promise<boolean>>

function pendingKey (origin: string, capability: CapabilityKind): string {
  return `${origin}\u0000${capability}`
}

/**
 * The real work of one `requestGrant` call, split out so `requestGrant`
 * itself can wrap it in the in-flight de-dup above without an `await`
 * between checking `pending` and claiming a slot in it -- seeing this
 * function's own promise is enough to claim the slot; nothing inside it
 * needs to run first.
 */
async function requestGrantOnce (
  broker: Broker,
  consent: ConsentPrompt,
  origin: string,
  request: CapabilityRequest & { capability: CapabilityKind }
): Promise<boolean> {
  let manifest
  try {
    manifest = await broker.app.manifest(origin)
  } catch {
    return false
  }

  const decision = decideGrantRequest(manifest, request.capability, request.patterns)
  if (!decision.allowed) return false

  // Decision 10: a capability declined earlier THIS RUN resolves false with
  // no prompt at all, however often a page calls requestGrant for it.
  // `install-consent.ts`'s own all-or-nothing accept, and this file's own
  // `clearDeclinedCapability` below, are the only ways off this list -- an
  // old "no" here is retired by a "yes", never by asking again.
  const declined = await broker.declinedCapabilitiesFor(origin)
  if (declined?.includes(request.capability) === true) return false

  const accepted = await consent(origin, request.capability, decision.patterns)
  if (!accepted) return false

  // A153 (docs/open-questions.md): `consent` above can await a real dialog
  // for up to 120 seconds, and installFromHint (./app-install.ts) can
  // re-register a narrower -- or entirely different -- manifest for this
  // same origin at any point while it is open, via a page re-triggering its
  // own <link rel="orivon-manifest"> hint by reloading itself. `decision`
  // was computed against whatever the manifest said BEFORE the dialog,
  // so it can no longer be trusted at commit time. Re-running
  // decideGrantRequest against a freshly read manifest, with the EXACT
  // patterns the person already saw and accepted as the request, answers
  // "does the manifest in force right now still allow what was approved" --
  // fail closed rather than commit a decision the current manifest disowns.
  let currentManifest
  try {
    currentManifest = await broker.app.manifest(origin)
  } catch {
    return false
  }
  const revalidated = decideGrantRequest(currentManifest, request.capability, decision.patterns)
  if (!revalidated.allowed) return false

  await broker.grant(origin, request.capability, revalidated.patterns)
  // A172(3): this is a SECOND door to a grant -- install-consent.ts's own
  // all-or-nothing accept clears an origin's whole declined-consent record
  // because it just re-asked about everything the manifest declares
  // ("an old no cannot outlive a yes", that file's header); this door only
  // just re-asked about ONE capability, so it retires ONE "no", leaving any
  // OTHER declined capability -- something this call was never asked
  // about -- alone.
  await clearDeclinedCapability(broker, origin, request.capability)
  return true
}

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
 *
 * `pending` is the real caller's ONE map, shared across every call this
 * running app makes (`request-grant-subsystem.ts` builds it once, at
 * wiring time) -- see `PendingGrantRequests`'s own doc for what it does and
 * why it is keyed the way it is. Omitted (every existing test that calls
 * this directly), the de-dup is simply off: each call is independent, which
 * is what a test asserting one call's own behaviour wants regardless.
 */
export async function requestGrant (
  broker: Broker,
  consent: ConsentPrompt,
  origin: string,
  request: CapabilityRequest,
  pending?: PendingGrantRequests
): Promise<boolean> {
  if (!isCapabilityKind(request.capability)) return false

  // ADR-0019, spec item 6: 'web.context' is declared-in-the-manifest-only in
  // this version, whatever the manifest declares -- app.requestGrant must
  // never mint one dynamically. THIS is the one door that stays shut; the
  // install-consent dialog (grant-prompt-render.ts's own 'web.context'
  // copy, via main/grant-changed-capabilities.ts) is the only door left.
  // Checked here rather than inside decideGrantRequest (../broker/policy/
  // request-grant.js): that function is ALSO grant-persistence.ts's own
  // "does a restored grant still fit the current manifest" check and this
  // file's own sibling's real grant call, and a blanket refusal there would
  // silently break both -- see decideGrantRequest's own doc for why.
  // ADR-0039's `web.embed` keeps the same one door: the install-consent
  // dialog, never a dynamic request.
  if (request.capability === 'web.context' || request.capability === 'web.embed') return false

  if (pending === undefined) return await requestGrantOnce(broker, consent, origin, { ...request, capability: request.capability })

  const key = pendingKey(origin, request.capability)
  const inFlight = pending.get(key)
  if (inFlight !== undefined) return await inFlight

  // Claimed SYNCHRONOUSLY, in the same tick as the `pending.get` check just
  // above, with no `await` in between: calling an async function runs it
  // synchronously up to its own first `await`, so a concurrent call arriving
  // before this one yields control anywhere will still find this promise
  // already in `pending` -- see PendingGrantRequests's own doc.
  const ask = requestGrantOnce(broker, consent, origin, { ...request, capability: request.capability })
  pending.set(key, ask)
  try {
    return await ask
  } finally {
    pending.delete(key)
  }
}

/**
 * Composed entirely from the two Broker methods already used above --
 * `declinedCapabilitiesFor`/`recordDeclinedConsent`/`clearDeclinedConsent`
 * -- no new bookkeeping primitive needed for this. Reads the record, drops
 * `capability` if present, and writes back whatever remains (or fully
 * clears it once nothing does).
 *
 * Exported for the site-info popover's own "turn on" path
 * (`../permissions/site-switches.js`): an old "no" for the one capability
 * being turned on must not outlive the "yes" that follows it, the same
 * A172(3) reasoning `requestGrant` above already applies to itself.
 */
export async function clearDeclinedCapability (broker: Broker, origin: string, capability: CapabilityKind): Promise<void> {
  const declined = await broker.declinedCapabilitiesFor(origin)
  if (declined === undefined || !declined.includes(capability)) return
  const remaining = declined.filter((existing) => existing !== capability)
  if (remaining.length === 0) await broker.clearDeclinedConsent(origin)
  else await broker.recordDeclinedConsent(origin, remaining)
}

/**
 * The mirror of `clearDeclinedCapability`, for the site-info popover's "turn
 * off" path: `broker.recordDeclinedConsent` REPLACES the whole decline set
 * (`../../broker/grants/declined-consent.js`'s own doc), so recording one
 * capability naively would forget every other capability this origin was
 * already declined for. Reads the record, adds `capability` if absent, and
 * writes back the union -- never overwrites unrelated declines.
 */
export async function addDeclinedCapability (broker: Broker, origin: string, capability: CapabilityKind): Promise<void> {
  const declined = await broker.declinedCapabilitiesFor(origin)
  if (declined?.includes(capability) === true) return
  await broker.recordDeclinedConsent(origin, [...(declined ?? []), capability])
}
