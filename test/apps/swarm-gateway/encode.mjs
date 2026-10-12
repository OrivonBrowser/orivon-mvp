// Swarm data as a publisher makes it, written from the formats and nothing
// else: chunks with their BMT addresses, Bee's left-filled file tree (with an
// optional redundancy level and fake parity references), Mantaray 0.2
// manifests, and signed feed updates. It imports nothing from src/, so a
// test using it checks the product's parsers against a second implementation.
import { bytesToHex, concat, hexToBytes, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export const CHUNK_SIZE = 4096
const SEGMENT = 32

/** @param {Uint8Array} bytes */
export const keccak = (bytes) => hexToBytes(keccak256(bytes))

/** The BMT root of a payload, by hashing the whole zero-padded 4096-byte tree level by level. @param {Uint8Array} payload */
export function bmtRoot (payload) {
  let level = new Uint8Array(CHUNK_SIZE)
  level.set(payload)
  while (level.length > SEGMENT) {
    const next = new Uint8Array(level.length / 2)
    for (let i = 0; i < level.length; i += 2 * SEGMENT) next.set(keccak(level.subarray(i, i + 2 * SEGMENT)), i / 2)
    level = next
  }
  return level
}

/** A chunk's address, lowercase hex without 0x. @param {Uint8Array} chunk span and payload */
export const chunkAddress = (chunk) => bytesToHex(keccak(concat([chunk.subarray(0, 8), bmtRoot(chunk.subarray(8))]))).slice(2)

/** Eight span bytes, little endian; a redundancy level sits in the top byte as 128 + level. */
export function spanBytes (size, level = 0) {
  const out = new Uint8Array(8)
  new DataView(out.buffer).setBigUint64(0, BigInt(size), true)
  if (level > 0) out[7] = 128 + level
  return out
}

/** @param {Uint8Array} span @param {Uint8Array} payload */
export const makeChunk = (span, payload) => concat([span, payload])

/** @param {Map<string, Uint8Array>} store @param {Uint8Array} chunk */
function put (store, chunk) {
  const address = chunkAddress(chunk)
  store.set(address, chunk)
  return address
}

const fakeParity = (index) => keccak(toBytes(`parity ${String(index)}`))

/**
 * A file as Bee's left-filled chunker stores it: 4096-byte leaves, 128
 * references to a chunk, a lone chunk at the end of a level carried up
 * unwrapped. With `level` above 0 every intermediate chunk carries its span's
 * level byte and `parity` references to chunks that are never stored, and
 * holds `128 - parity` data references.
 * @param {Uint8Array} bytes
 * @param {Map<string, Uint8Array>} store
 * @param {{ level?: number, parity?: number }} [options]
 * @returns {{ ref: string, size: number }}
 */
export function buildFile (bytes, store, options = {}) {
  const level = options.level ?? 0
  const parity = level > 0 ? (options.parity ?? 5) : 0
  const fanout = 128 - parity
  /** @type {Array<{ ref: string, size: number }>} */
  let items = []
  for (let at = 0; at === 0 || at < bytes.length; at += CHUNK_SIZE) {
    const piece = bytes.subarray(at, at + CHUNK_SIZE)
    items.push({ ref: put(store, makeChunk(spanBytes(piece.length), piece)), size: piece.length })
  }
  while (items.length > 1) {
    /** @type {typeof items} */
    const next = []
    for (let i = 0; i < items.length; i += fanout) {
      const group = items.slice(i, i + fanout)
      if (group.length === 1) { next.push(group[0]); continue }
      const size = group.reduce((sum, item) => sum + item.size, 0)
      const refs = group.map((item) => hexToBytes(`0x${item.ref}`))
      for (let p = 0; p < parity; p++) refs.push(fakeParity(p))
      next.push({ ref: put(store, makeChunk(spanBytes(size, level), concat(refs))), size })
    }
    items = next
  }
  return items[0]
}

const VERSION_02 = keccak(toBytes('mantaray:0.2')).subarray(0, 31)
const TYPE = { value: 2, edge: 4, pathSeparator: 8, metadata: 16 }
const MAX_PREFIX = 30

/** @typedef {{ prefix: Uint8Array, node: TrieNode, metadata: Record<string, string> | undefined }} Fork */
/** @typedef {{ entry: string | undefined, forks: Map<number, Fork> }} TrieNode */

function commonPrefix (a, b) {
  let k = 0
  while (k < a.length && k < b.length && a[k] === b[k]) k++
  return k
}

function addChain (node, path, leaf, metadata) {
  let at = node
  let rest = path
  while (rest.length > MAX_PREFIX) {
    const middle = { entry: undefined, forks: new Map() }
    at.forks.set(rest[0], { prefix: rest.slice(0, MAX_PREFIX), node: middle, metadata: undefined })
    at = middle
    rest = rest.slice(MAX_PREFIX)
  }
  at.forks.set(rest[0], { prefix: rest, node: leaf, metadata })
}

/** @param {TrieNode} node */
function insert (node, path, entry, metadata) {
  const fork = node.forks.get(path[0])
  if (fork === undefined) { addChain(node, path, { entry, forks: new Map() }, metadata); return }
  const k = commonPrefix(fork.prefix, path)
  if (k < fork.prefix.length) {
    const middle = { entry: undefined, forks: new Map() }
    middle.forks.set(fork.prefix[k], { prefix: fork.prefix.slice(k), node: fork.node, metadata: fork.metadata })
    fork.prefix = fork.prefix.slice(0, k)
    fork.node = middle
    fork.metadata = undefined
  }
  const rest = path.slice(k)
  if (rest.length === 0) { fork.node.entry = entry; fork.metadata = metadata } else insert(fork.node, rest, entry, metadata)
}

/** JSON padded with newlines so the length field plus the JSON fill whole 32-byte rows. */
function metadataBytes (metadata) {
  const json = toBytes(JSON.stringify(metadata))
  const padded = new Uint8Array(Math.ceil((json.length + 2) / SEGMENT) * SEGMENT - 2).fill(0x0a)
  padded.set(json)
  return padded
}

/**
 * @param {TrieNode} node
 * @param {Map<string, Uint8Array>} store
 * @param {{ obfuscationKey?: Uint8Array, level?: number }} options
 * @returns {string} the reference of the node's file
 */
function marshal (node, store, options) {
  const parts = []
  const bitmap = new Uint8Array(32)
  for (const byte of [...node.forks.keys()].sort((a, b) => a - b)) {
    const fork = node.forks.get(byte)
    bitmap[byte >> 3] |= 1 << (byte & 7)
    const child = marshal(fork.node, store, options)
    let type = 0
    if (fork.node.entry !== undefined) type |= TYPE.value
    if (fork.node.forks.size > 0) type |= TYPE.edge
    if (fork.prefix.subarray(1).includes(0x2f)) type |= TYPE.pathSeparator
    if (fork.metadata !== undefined) type |= TYPE.metadata
    const prefix = new Uint8Array(MAX_PREFIX)
    prefix.set(fork.prefix)
    parts.push(Uint8Array.of(type, fork.prefix.length), prefix, hexToBytes(`0x${child}`))
    if (fork.metadata !== undefined) {
      const meta = metadataBytes(fork.metadata)
      parts.push(Uint8Array.of(meta.length >> 8, meta.length & 255), meta)
    }
  }
  const entry = node.entry === undefined ? new Uint8Array(32) : hexToBytes(`0x${node.entry}`)
  const body = concat([VERSION_02, Uint8Array.of(32), entry, bitmap, ...parts])
  const key = options.obfuscationKey ?? new Uint8Array(32)
  const hidden = body.map((byte, i) => byte ^ key[i % 32])
  return buildFile(concat([key, hidden]), store, { level: options.level ?? 0 }).ref
}

/**
 * A Mantaray 0.2 manifest and every node of it stored as a file.
 * @param {Array<{ path: string, entry?: string, metadata?: Record<string, string> }>} entries `entry`: the reference of the file at `path`, none for a metadata-only entry such as `/`
 * @param {Map<string, Uint8Array>} store
 * @param {{ obfuscationKey?: Uint8Array, level?: number }} [options] `obfuscationKey`: 32 bytes, zeros when omitted
 * @returns {string} the root reference
 */
export function buildManifest (entries, store, options = {}) {
  /** @type {TrieNode} */
  const root = { entry: undefined, forks: new Map() }
  for (const { path, entry, metadata } of entries) insert(root, toBytes(path), entry ?? '0'.repeat(64), metadata)
  return marshal(root, store, options)
}

/**
 * A website: each file stored, a manifest naming them, the index document on `/`.
 * @param {Record<string, string | Uint8Array>} files path (no leading slash) -> content
 * @param {Map<string, Uint8Array>} store
 * @param {{ indexDocument?: string, contentTypes?: Record<string, string>, obfuscationKey?: Uint8Array, level?: number }} [options]
 * @returns {string} the root reference
 */
export function buildSite (files, store, options = {}) {
  const entries = [{ path: '/', metadata: { 'website-index-document': options.indexDocument ?? 'index.html' } }]
  for (const [path, content] of Object.entries(files)) {
    const bytes = typeof content === 'string' ? toBytes(content) : content
    const type = options.contentTypes?.[path]
    entries.push({
      path,
      entry: buildFile(bytes, store, { level: options.level ?? 0 }).ref,
      metadata: { Filename: path.split('/').pop(), ...(type !== undefined && { 'Content-Type': type }) }
    })
  }
  return buildManifest(entries, store, options)
}

export const feedKey = (owner, topic) => `${owner}/${topic}`

/** The address of the single-owner chunk holding update `index` of a feed. @param {string} owner 40 hex @param {string} topic 64 hex */
export function feedSocAddress (owner, topic, index) {
  const id = feedId(topic, index)
  return bytesToHex(keccak(concat([id, hexToBytes(`0x${owner}`)]))).slice(2)
}

function feedId (topic, index) {
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, BigInt(index), false)
  return keccak(concat([hexToBytes(`0x${topic}`), at]))
}

/** The legacy update payload: an eight-byte timestamp and a reference, as a chunk of span 40. */
export function legacyUpdate (reference, timestamp = 1_700_000_000n) {
  const stamp = new Uint8Array(8)
  new DataView(stamp.buffer).setBigUint64(0, timestamp, false)
  return makeChunk(spanBytes(40), concat([stamp, hexToBytes(`0x${reference}`)]))
}

/**
 * Update `index` of a feed, signed by `privateKey`.
 * @param {{ privateKey: `0x${string}`, topic: string, index: number | bigint, wrapped: Uint8Array }} update `wrapped`: the chunk (span and payload) the update carries
 * @returns {Promise<{ owner: string, address: string, chunk: Uint8Array }>} `chunk` is the single-owner chunk as a node stores it
 */
export async function signFeedUpdate ({ privateKey, topic, index, wrapped }) {
  const account = privateKeyToAccount(privateKey)
  const owner = account.address.slice(2).toLowerCase()
  const id = feedId(topic, index)
  const digest = keccak(concat([id, hexToBytes(`0x${chunkAddress(wrapped)}`)]))
  const signature = hexToBytes(await account.signMessage({ message: { raw: digest } }))
  return { owner, address: feedSocAddress(owner, topic, index), chunk: concat([id, signature, wrapped]) }
}

/** The owner address (40 hex) of a private key. */
export const ownerOf = (privateKey) => privateKeyToAccount(privateKey).address.slice(2).toLowerCase()

/**
 * A feed manifest: the `/` entry carries the feed's owner and topic.
 * @returns {string} the root reference
 */
export function buildFeedManifest ({ owner, topic, type = 'Sequence' }, store, options = {}) {
  return buildManifest([{ path: '/', metadata: { 'swarm-feed-owner': owner, 'swarm-feed-topic': topic, 'swarm-feed-type': type } }], store, options)
}
