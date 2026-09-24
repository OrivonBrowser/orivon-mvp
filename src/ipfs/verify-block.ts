import * as dagPb from '@ipld/dag-pb'
import type { CID } from 'multiformats/cid'
import { equals } from 'multiformats/bytes'
import { sha256 } from 'multiformats/hashes/sha2'

export const DAG_PB = 0x70
export const RAW = 0x55
const SHA2_256 = 0x12
const SHA2_256_BYTES = 32
const IDENTITY = 0x00

/** Why a block's bytes were not used. `mismatch` means the source lied; the others, that this build does not take the risk. */
export type RefusalReason = 'mismatch' | 'hash-function' | 'codec' | 'too-large' | 'too-many-links'

export class BlockRefused extends Error {
  override readonly name = 'BlockRefused'
  constructor (readonly reason: RefusalReason, readonly cid: string, message: string) {
    super(message)
  }
}

/** Refused before any byte is fetched: nothing a source could send would be usable. */
export function checkCidAccepted (cid: CID): void {
  if (cid.code !== DAG_PB && cid.code !== RAW) throw new BlockRefused('codec', cid.toString(), `codec 0x${cid.code.toString(16)} is not dag-pb or raw`)
  const hash = cid.multihash.code
  if (hash !== SHA2_256 && hash !== IDENTITY) throw new BlockRefused('hash-function', cid.toString(), `hash function 0x${hash.toString(16)} is not sha2-256`)
  // A truncated digest would make honest bytes read as a lie, and the gateway that sent them be dropped.
  if (hash === SHA2_256 && cid.multihash.size !== SHA2_256_BYTES) throw new BlockRefused('hash-function', cid.toString(), `a sha2-256 digest of ${String(cid.multihash.size)} bytes, not ${String(SHA2_256_BYTES)}`)
}

/** An identity CID carries its block inside itself, so it never touches the network. */
export function inlineBlock (cid: CID): Uint8Array | undefined {
  return cid.multihash.code === IDENTITY ? cid.multihash.digest : undefined
}

/**
 * Throws unless `bytes` is exactly the block `cid` names and within the
 * limits. Only after this returns may any of `bytes` be used.
 */
export async function verifyBlock (cid: CID, bytes: Uint8Array, limits: { maxBlockBytes: number, maxLinksPerNode: number }): Promise<void> {
  checkCidAccepted(cid)
  const id = cid.toString()
  if (bytes.length > limits.maxBlockBytes) throw new BlockRefused('too-large', id, `block is ${String(bytes.length)} bytes, over ${String(limits.maxBlockBytes)}`)
  const inline = inlineBlock(cid)
  const matches = inline !== undefined ? equals(inline, bytes) : equals((await sha256.digest(bytes)).digest, cid.multihash.digest)
  if (!matches) throw new BlockRefused('mismatch', id, 'block does not hash to its CID')
  if (cid.code === DAG_PB) {
    let links: number
    try {
      links = dagPb.decode(bytes).Links.length
    } catch (error) {
      // It hashed correctly, so the site published it: malformed, not tampered.
      throw new BlockRefused('codec', id, `not a valid dag-pb node: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (links > limits.maxLinksPerNode) throw new BlockRefused('too-many-links', id, `node has ${String(links)} links, over ${String(limits.maxLinksPerNode)}`)
  }
}
