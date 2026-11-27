import type { Address, Hex } from 'viem'

// What the resolver knows about Linagee before it asks a node anything: the three contracts, the one resolver
// implementation it vouches for, the event topics it reads, and the keys a name's records are read from. Every address
// and topic here is checked against the chain by the census tool and by the tests; none is read from a name or a node.

/** A log's place on chain: blocks order first, then the log's index in its block. */
export interface Position { readonly block: number, readonly logIndex: number }

/** The 2015 registry: immutable, no admin and no fee. A name is owned by one account until it moves it. */
export const REGISTRY: Address = '0x5564886ca2C518d1964E5FCea4f423b41Db9F561'

/** The ERC-721 wrapper: holds a wrapped name in the registry and gives its holder a token. Its owner cannot move a name. */
export const WRAPPER: Address = '0x2Cc8342d7c8BFf5A213eb2cdE39DE9a59b3461A7'

/** The text records and controllers of every name: an upgradeable proxy, so a name's records are only as good as its implementation. */
export const PROXY: Address = '0x6023E55814DC00F094386d4eb7e17Ce49ab1A190'

/** The one implementation of `PROXY` the resolver answers from. It cannot change its own code (EIP-6780); the proxy can be pointed elsewhere. */
export const IMPLEMENTATION: Address = '0xdb50876f0924F67916C9891c9f369c8103dA1506'

/** Multicall3, at the same address on every chain it is deployed to. Only its `aggregate3` is used, and only to read. */
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

/**
 * Every `Upgraded` log `PROXY` ever emitted, in chain order, the last one pointing at `IMPLEMENTATION`. A census is trusted for
 * history only when its list is exactly this one: an upgrade to other code and back before the checkpoint would leave records
 * the pinned implementation never wrote, and the slot alone cannot show it.
 */
export const UPGRADES: readonly (Position & { readonly implementation: Address })[] = Object.freeze([
  Object.freeze({ block: 15_829_140, logIndex: 73, implementation: '0xb2683aF58e92c63199f22b5788cFE52C26868620' as Address }),
  Object.freeze({ block: 15_847_254, logIndex: 130, implementation: '0x2F2ee062e0386Ba9f5E0B5ee0a3A1DE6a1d63279' as Address }),
  Object.freeze({ block: 16_006_600, logIndex: 144, implementation: '0xeaB077eE281E4C2b6f9C94e7497eacAF804DD472' as Address }),
  Object.freeze({ block: 17_161_959, logIndex: 223, implementation: IMPLEMENTATION })
])

/** Where an ERC-1967 proxy keeps the address of its implementation. */
export const IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc'

export const TOPICS = Object.freeze({
  /** `Changed(bytes32 indexed name)` on the registry: a reserve, transfer, disown or setter of the name. */
  changed: '0xa6697e974e6a320f454390be03f74955e8978f1a6971ea6730542e37b66179bc',
  /** `Transfer(address indexed from, address indexed to, uint256 indexed tokenId)` on the wrapper. */
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  /** `SetTextRecord(bytes32 indexed name, string indexed key, string indexed value)`: the key and the value are their hashes. */
  setTextRecord: '0x2d0e50011f4a7d11d9b4915eb1bf1f6d8f5c1d87b58c6f8ebfefd2ede2917455',
  /** `NewController(bytes32 indexed name, address indexed controller)` on the proxy. */
  newController: '0xe5108446a6097aab57fd36f346a515a78fddefa87d81662d44e0d7a463f92095',
  /** `Upgraded(address indexed implementation)` on the proxy. */
  upgraded: '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b'
} as const)

/** The block each contract was created in: no log of it is older. */
export const DEPLOY_BLOCKS = Object.freeze({ registry: 51807, wrapper: 15663114, proxy: 15829140 })

/** The text key each record type is read from, in the order the answer lists them. */
export const TEXT_KEYS: readonly (readonly [string, string])[] = Object.freeze([
  ['content.ipfs', 'ipfs'], ['content.bzz', 'bzz'], ['content.arw', 'arw'], ['content.magnet', 'magnet'],
  ['content.ethfs', 'ethfs'], ['content.https', 'https'], ['content.http', 'http'], ['content.ddoc', 'ddoc']
] as const)

/** The key a site published by `web3://` uses. Written by other Linagee interfaces; the census keeps it for names that have one. */
export const CONTRACT_KEY = 'contentcontract'

/** Every key a census entry is cut for. */
export const CENSUS_KEYS: readonly string[] = Object.freeze([...TEXT_KEYS.map(([key]) => key), CONTRACT_KEY])

/**
 * The name under which the registry's own `content(bytes32)` slot stands among the records that count. It is not a text key: the slot is
 * never read with `getTextRecord`, so no text key of any name can be mistaken for it.
 */
export const REGISTRY_CONTENT = 'registry.content'

/**
 * The block the census tool starts reading the registry's `Changed` logs from to find the names that hold a value in the `content` slot.
 * A read of the slot of every label the registry has ever seen (539,105, at block 26,450,231) found three names with a value, and the
 * first write of any of them is after this block. A name whose slot was written before it is not in the census, has no `setContent` log
 * the resolver reads, and so never counts: that fails closed, and a cut of the census at any block gives the same file.
 */
export const REGISTRY_CONTENT_FLOOR = 26_400_000
