// Where the gate finds the picker, the app media grants and the share registry. Each is bound by the installer that
// builds it; until then the gate refuses: no picker chooses nothing, no grants hold nothing, no registry lists nothing.
import type { AppMediaGrants, ChooseDisplaySource, ShareRegistry } from './types.js'

let chooser: ChooseDisplaySource | undefined
let grants: AppMediaGrants | undefined
let registry: ShareRegistry | undefined

const NO_SHARES: ShareRegistry = {
  list: () => [],
  forRequester: () => [],
  forCaptured: () => [],
  capturePending: () => false,
  onChange: () => () => {},
  stop: () => {}
}

export const chooseDisplaySource: ChooseDisplaySource = async (request, signal) =>
  chooser === undefined ? null : await chooser(request, signal)

export function bindDisplayChooser (choose: ChooseDisplaySource | undefined): void {
  chooser = choose
}

export const appMediaGrants: AppMediaGrants = {
  held: (origin, kind) => grants?.held(origin, kind) ?? false,
  request: async (tab, origin, kind) => grants === undefined ? false : await grants.request(tab, origin, kind)
}

export function bindAppMediaGrants (bound: AppMediaGrants | undefined): void {
  grants = bound
}

export function shareRegistry (): ShareRegistry {
  return registry ?? NO_SHARES
}

const rebinders = new Set<() => void>()

/** Calls `listener` after the share registry is bound or replaced, so what follows it can move to the new one. Returns the removal. */
export function onShareRegistryBound (listener: () => void): () => void {
  rebinders.add(listener)
  return () => { rebinders.delete(listener) }
}

export function bindShareRegistry (bound: ShareRegistry | undefined): void {
  registry = bound
  for (const listener of [...rebinders]) listener()
}
