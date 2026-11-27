import type { Chain } from './chain.js'
import { sameAddress } from './hex.js'
import type { Call } from './launcher.js'
import { IMPLEMENTATION_SLOT, PROXY, TOPICS, UPGRADES } from './pins.js'
import { OgRefusal, scanLogs } from './tail.js'
import type { ScanOptions, Scan, Session } from './tail.js'

// The guard on the resolver contract. The records live in an upgradeable proxy that a Safe of nine owners (five to act) can
// point at any code in one transaction, with no delay, so a record is only as good as the implementation behind it. This
// resolver answers from one implementation it was built against. The proxy must still point at it, the census must list exactly the
// upgrades the proxy had (`UPGRADES`), and no upgrade of the proxy may have been logged after the census checkpoint: pointing the
// proxy at other code and back leaves the slot as it was and an `Upgraded` log behind. Any check failing, or the scan that makes the
// last not finishing, refuses the answer.

/** The scan of every `Upgraded` log of the proxy: the same for every name, so a resolver makes it once. */
export const upgradedScan = (from: number, to: number): Scan => ({
  id: 'upgraded',
  address: PROXY,
  topics: [TOPICS.upgraded],
  from,
  to,
  accept: (log) => sameAddress(log.address, PROXY) && log.topics[0]?.toLowerCase() === TOPICS.upgraded,
  // One upgrade is the refusal of every name: a server that invented one in old history refuses this call, never every call after it.
  refuses: (logs) => logs.length > 0
})

/** The address an ERC-1967 implementation slot holds: the last 20 bytes of its 32, whatever length the node trimmed the value to. */
export const implementationIn = (slot: string): string => `0x${slot.slice(2).padStart(64, '0').slice(24)}`

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/**
 * What differs between a list of the proxy's upgrades and the pinned one (`UPGRADES`), in words, or null when they are the same.
 * The census holds history up to its checkpoint as the bundle's word, and a round trip through other code before it would not show
 * in the slot or in the tail, so the list must be the one this resolver was built against, entry for entry.
 * @param upgrades the `upgrades` of a census, or what the proxy's `Upgraded` logs gave
 */
export function upgradesProblem (upgrades: unknown): string | null {
  const found: unknown[] = Array.isArray(upgrades) ? upgrades : []
  const at = (one: unknown, pinned: { block: number, logIndex: number }): boolean => isObject(one) && one['block'] === pinned.block && one['logIndex'] === pinned.logIndex
  for (const pinned of UPGRADES) {
    const one = found.find((candidate) => at(candidate, pinned))
    if (one === undefined) return `the upgrade at block ${String(pinned.block)} is missing`
    const implementation = (one as Record<string, unknown>)['implementation']
    if (typeof implementation !== 'string' || !sameAddress(implementation, pinned.implementation)) return `the upgrade at block ${String(pinned.block)} is not the one the pin lists`
  }
  const extra = found.find((candidate) => !UPGRADES.some((pinned) => at(candidate, pinned)))
  if (extra !== undefined) return isObject(extra) && typeof extra['block'] === 'number' ? `the proxy logged an upgrade at block ${String(extra['block'])} that the pin does not list` : 'the list holds an entry that is not an upgrade'
  return found.length === UPGRADES.length ? null : 'the list holds an upgrade twice'
}

export interface GuardRequest extends ScanOptions {
  readonly block: number
  readonly final: number
  readonly call: Call
  /** The census block, the last block the bundle vouches for. */
  readonly checkpoint: number
  /** The implementation the bundle was built against. */
  readonly implementation: string
  /** The upgrades the census lists up to the checkpoint. */
  readonly upgrades: unknown
}

/** Whether the proxy may be trusted at `block`. Resolves when it may; refuses in words when it may not or when that cannot be told. */
export async function guardResolver (chain: Chain, session: Session, request: GuardRequest): Promise<void> {
  const { block, final, call, checkpoint, implementation, upgrades: listed, deadlineAt, signal } = request
  if (upgradesProblem(listed) !== null) {
    throw new OgRefusal("The upgrades of the contract that holds .og records, as this resolver's bundle lists them, are not the ones this resolver was built for, so its records are not vouched for. Update the .og resolver.")
  }
  const [slot, upgrades] = await Promise.all([
    chain.getStorageAt(PROXY, IMPLEMENTATION_SLOT, block),
    scanLogs(chain, session, upgradedScan(checkpoint + 1, block), { deadlineAt, signal, what: 'the resolver contract for upgrades', call, final })
  ])
  if (!sameAddress(implementationIn(slot), implementation)) {
    throw new OgRefusal('The contract that holds .og records now runs code this resolver was not built for, so its records are not vouched for. Update the .og resolver.')
  }
  if (upgrades.length > 0) {
    throw new OgRefusal('The contract that holds .og records was upgraded after this resolver was built, so its records are not vouched for. Update the .og resolver.')
  }
}
