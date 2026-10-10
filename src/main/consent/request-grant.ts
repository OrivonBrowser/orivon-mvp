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
import { isUnrecordedLocalFile } from '../local-files/local-file-apps.js'
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
export type ConsentPrompt = (origin: string, capability: CapabilityKind, patterns: readonly Pattern[], caller?: DialogCaller, abandoned?: AbortSignal) => Promise<boolean>

/**
 * What a dialog needs to know about the page that asked, without owning an
 * Electron object itself: whether it should even appear, and what to parent
 * it to. `window` and `stillOn` are both read AT SHOW TIME, never captured
 * once -- the whole reason this is a pair of closures and not a snapshot is
 * that a page can navigate the tab away, or close it, at any point during
 * the manifest read and the dialog's own wait for an answer (up to 120
 * seconds, A153's own timing). `window` returns `unknown` rather than a real
 * `BrowserWindow`/`BaseWindow` so this stays importable by every Electron-
 * free file in this directory; the *-prompt.ts file that actually calls
 * `dialog.showMessageBox` is the one place that casts it back.
 */
export interface DialogCaller {
  /** The window currently holding the calling tab, or undefined if the tab cannot be resolved to one (closed, or moved somewhere this process lost track of). */
  window: () => unknown
  /** True while the call that asked is still alive and its top frame has not left `origin`. */
  stillOn: (origin: string) => boolean
  /**
   * An opaque identity for the calling WebContents, compared only by `===`
   * and never dereferenced -- the same "compare, don't read" treatment
   * `isAttributedSession` gives a `Session` (`../../broker/policy/origin.js`).
   * `PendingGrantRequests` keys its outer map on this so two different tabs
   * asking for the same (origin, capability, patterns) never share one
   * dialog or its answer; omitted, every caller is treated as the same
   * identity-less one, which is what every existing caller-less call already
   * got.
   */
  id?: unknown
  /** The calling tab's `WebContents`, opaque here like `window()`: the panel a question is drawn in belongs to that tab, and its navigation is held while the question is open. */
  contents?: () => unknown
  /** Holds the calling tab's page where it is until the returned function is called. Set where the first-visit flow runs, which takes it from before the origin is registered; the prompts take their own around each question. */
  hold?: () => () => void
  /** Aborts when whatever asked no longer wants the answer (a first visit whose page was stopped): the question it opened is withdrawn as a cancel. */
  signal?: AbortSignal
}

/**
 * One in-flight `requestGrant` call per (caller, origin, capability,
 * requested patterns): a second call for the same tuple, made while the
 * first is still awaiting its `consent` dialog (or anything before it),
 * shares that first call's eventual answer instead of opening a second
 * dialog. Keyed narrower than plan decision 10's own wording ("one pending
 * prompt per origin") on purpose: two DIFFERENT capabilities requested
 * concurrently for one origin are two different questions, and applying
 * one's answer to the other would be a correctness bug (grant `fs` because
 * `tcp.connect` happened to be approved, or the reverse), not a UX nicety --
 * a burst of calls all asking for the SAME capability, in a loop or all at
 * once, is what this still fully closes.
 *
 * The OUTER map is keyed on `caller?.id` (`DialogCaller`'s own doc) rather
 * than folded into the same string key as the rest: two different tabs
 * asking for the identical (origin, capability, patterns) at once must
 * never share a dialog or its parent window, so their pending slots must
 * never collide, however their string keys would compare. Every caller-less
 * call (every existing call site that omits `caller`) shares the single
 * `undefined` outer key, preserving the one-dialog-per-tuple sharing this
 * had before `id` existed.
 *
 * Inner maps, not a `WeakMap`: the inner key is a string, not an object,
 * and entries are removed (see `requestGrant` below) the instant their call
 * settles, so nothing here outlives the request it was made for; an empty
 * inner map is removed too, so a tab that stops calling leaves no trace.
 */
export type PendingGrantRequests = Map<unknown, Map<string, Promise<boolean>>>

function pendingKey (origin: string, capability: CapabilityKind, patterns: readonly Pattern[] | undefined): string {
  // Sorted: two calls requesting the same set of patterns in a different
  // order are the same question and must share one dialog; unsorted, they
  // would spuriously open two.
  const patternKey = patterns === undefined ? '' : [...patterns].sort().join('\u0000')
  return `${origin}\u0000${capability}\u0000${patternKey}`
}

/**
 * The tail of each origin's dialog queue, for one running app's whole
 * lifetime -- a second call for the SAME origin but a DIFFERENT capability,
 * so it shares no entry in `PendingGrantRequests` above, still waits for
 * whatever this map says came before it. `PendingGrantRequests` alone only
 * gives "one dialog per origin per capability"; this is what makes it "one
 * dialog per origin, period" (plan decision 10's own wording), by delaying
 * the CONSENT CALL itself, never the manifest read or the declined-consent
 * check ahead of it -- those never show anything, so nothing is lost by
 * letting every concurrent call run them right away.
 *
 * Not `../install/origin-queue.js`'s `withOriginQueue`: that module lives
 * one directory over, in a tree this file's own siblings (`app-install.ts`
 * -> `install-consent.ts`) are imported BY, so importing it here would be a
 * cycle. `withOriginTurn` below is this file's own, much smaller version --
 * queuing a single dialog call, not a whole task with its own re-entrancy
 * tracking.
 */
export type PendingGrantPrompts = Map<string, Promise<void>>

/**
 * Runs `task` after every earlier `withOriginTurn` call for `origin` has
 * settled, chaining onto `turns` the same way `origin-queue.ts`'s own
 * `withOriginQueue` does. `task`'s own success or failure never affects the
 * next caller's turn: the queued promise resolves once `task` SETTLES,
 * whichever way, so one dialog erroring never wedges the next one.
 */
async function withOriginTurn<T> (origin: string, turns: PendingGrantPrompts, task: () => Promise<T>): Promise<T> {
  const ahead = turns.get(origin) ?? Promise.resolve()
  let release: () => void = () => {}
  const mine = new Promise<void>((resolve) => { release = resolve })
  const settled = ahead.then(() => mine)
  turns.set(origin, settled)
  await ahead
  try {
    return await task()
  } finally {
    release()
    void settled.then(() => { if (turns.get(origin) === settled) turns.delete(origin) })
  }
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
  request: CapabilityRequest & { capability: CapabilityKind },
  caller?: DialogCaller,
  prompts?: PendingGrantPrompts,
  abandoned?: AbortSignal
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

  // The caller's own IPC transport times out a call it has waited too long
  // for (A153) well before withOriginTurn's queue necessarily reaches this
  // call's turn -- the app already has its answer (a timeout failure) by
  // then, so showing a dialog for it now would parent one to a call nobody
  // is still waiting on. Checked right as this call's turn starts, never
  // earlier: `abandoned` can fire at any point while this sat queued.
  const askConsent = async (): Promise<boolean> => {
    if (abandoned?.aborted === true) return false
    if (caller === undefined) return await consent(origin, request.capability, decision.patterns)
    // The signal travels with the question: a question drawn in a tab that is
    // not in front waits for the tab, and the origin's turn is held meanwhile,
    // so a call that gave up has to be able to take its question back.
    return abandoned === undefined
      ? await consent(origin, request.capability, decision.patterns, caller)
      : await consent(origin, request.capability, decision.patterns, caller, abandoned)
  }
  const accepted = prompts === undefined ? await askConsent() : await withOriginTurn(origin, prompts, askConsent)

  // The page that asked may have navigated away, or closed, before the
  // dialog ever showed, or at any point during the up to 120 seconds it
  // waited for an answer (A153) -- either way, whatever `accepted` says,
  // nobody who can still see this origin actually answered it. Treated like
  // a decline for what happens next (nothing is granted), but NOT recorded
  // as one: nothing in this function ever writes a decline for a `false`
  // consent() answer regardless (that only happens through the site-info
  // popover, ../permissions/site-switches.js), so a later, genuine ask for
  // this origin still prompts.
  if (caller !== undefined && !caller.stillOn(origin)) return false
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
 * `pending` and `prompts` are the real caller's own maps, shared across
 * every call this running app makes (`request-grant-subsystem.ts` builds
 * each once, at wiring time) -- see `PendingGrantRequests`'s and
 * `PendingGrantPrompts`'s own docs for what each does. Both omitted (every
 * existing test that calls this directly), the de-dup and the per-origin
 * queue are simply off: each call is independent, which is what a test
 * asserting one call's own behaviour wants regardless.
 *
 * `caller`, when supplied, is the tab that actually asked -- see
 * `DialogCaller`'s own doc. Omitted, every dialog this call can reach shows
 * unconditionally and its answer is trusted regardless of what the calling
 * page has done since, the same as before this parameter existed.
 *
 * `abandoned`, when supplied, is the caller's own IPC timeout signal --
 * `askConsent`'s own doc, inside `requestGrantOnce`, says exactly when it is
 * checked and why.
 */
export async function requestGrant (
  broker: Broker,
  consent: ConsentPrompt,
  origin: string,
  request: CapabilityRequest,
  pending?: PendingGrantRequests,
  caller?: DialogCaller,
  prompts?: PendingGrantPrompts,
  abandoned?: AbortSignal
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

  // A file on this computer holds grants only after the person let it use Orivon permissions (its own double-press question);
  // before that, and after a No, a page there cannot ask for one through this door.
  if (isUnrecordedLocalFile(origin)) return false

  if (pending === undefined) return await requestGrantOnce(broker, consent, origin, { ...request, capability: request.capability }, caller, prompts, abandoned)

  const callerId = caller?.id
  let byCaller = pending.get(callerId)
  if (byCaller === undefined) {
    byCaller = new Map()
    pending.set(callerId, byCaller)
  }

  const key = pendingKey(origin, request.capability, request.patterns)
  const inFlight = byCaller.get(key)
  if (inFlight !== undefined) return await inFlight

  // Claimed SYNCHRONOUSLY, in the same tick as the `byCaller.get` check just
  // above, with no `await` in between: calling an async function runs it
  // synchronously up to its own first `await`, so a concurrent call arriving
  // before this one yields control anywhere will still find this promise
  // already in `byCaller` -- see PendingGrantRequests's own doc.
  const ask = requestGrantOnce(broker, consent, origin, { ...request, capability: request.capability }, caller, prompts, abandoned)
  byCaller.set(key, ask)
  try {
    return await ask
  } finally {
    byCaller.delete(key)
    if (byCaller.size === 0) pending.delete(callerId)
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
