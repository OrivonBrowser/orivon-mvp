// Whether this build's Electron binary leaves `file:` pages their extra privileges.
// Tied to Electron: the answer is a byte inside the binary's fuse wire.

import { open } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type FileProtocolFuse = 'off' | 'on' | 'unknown'

/** Electron's fuse wire follows this string, then a version byte, a length byte and one state byte per fuse. */
export const FUSE_SENTINEL = 'dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'
export const FILE_PROTOCOL_FUSE_INDEX = 7
export const FUSE_DISABLED = 48
export const FUSE_ENABLED = 49
export const FUSE_REMOVED = 114

const WIRE_VERSION = 1
const WIRE_HEADER_BYTES = 2
const MAX_WIRE_BYTES = 255
const DEFAULT_CHUNK_BYTES = 1024 * 1024

/** The file that carries the fuse wire: the executable, or on macOS the framework binary beside it. */
export function fuseFilePath (executable: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'darwin' || !executable.includes('.app')) return executable
  return join(dirname(executable), '..', 'Frameworks', 'Electron Framework.framework', 'Electron Framework')
}

/** Streams the file in chunks, so the 200 MB binary is never held whole. */
async function sentinelOffsets (path: string, chunkBytes: number): Promise<number[]> {
  const needle = Buffer.from(FUSE_SENTINEL)
  const handle = await open(path, 'r')
  try {
    const offsets: number[] = []
    const chunk = Buffer.alloc(chunkBytes)
    // The last needle.length - 1 bytes of each chunk are searched again with the next one, so a sentinel
    // that straddles a boundary is found once, and one lying fully inside the carry is never seen twice.
    let carry = Buffer.alloc(0)
    let position = 0
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunkBytes, position)
      if (bytesRead === 0) break
      const window = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
      const windowStart = position - carry.length
      for (let at = window.indexOf(needle); at !== -1; at = window.indexOf(needle, at + 1)) {
        offsets.push(windowStart + at)
      }
      carry = window.subarray(Math.max(0, window.length - (needle.length - 1)))
      position += bytesRead
    }
    return offsets
  } finally {
    await handle.close()
  }
}

async function stateAt (path: string, sentinelOffset: number): Promise<number | undefined> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(WIRE_HEADER_BYTES + MAX_WIRE_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, sentinelOffset + FUSE_SENTINEL.length)
    if (bytesRead < WIRE_HEADER_BYTES || buffer[0] !== WIRE_VERSION) return undefined
    const wireLength = buffer[1] as number
    const stateIndex = WIRE_HEADER_BYTES + FILE_PROTOCOL_FUSE_INDEX
    if (wireLength <= FILE_PROTOCOL_FUSE_INDEX || bytesRead <= stateIndex) return undefined
    return buffer[stateIndex]
  } finally {
    await handle.close()
  }
}

/**
 * `'off'` only when the binary has a sentinel and every one it has (a universal build has two) says the
 * fuse is disabled. A missing file, an unknown wire version, a wire too short to hold the fuse, a removed
 * fuse or sentinels that disagree are `'unknown'`: a caller treats anything but `'off'` as on.
 */
export async function readFileProtocolFuse (path: string, chunkBytes = DEFAULT_CHUNK_BYTES): Promise<FileProtocolFuse> {
  try {
    const offsets = await sentinelOffsets(path, chunkBytes)
    if (offsets.length === 0) return 'unknown'
    const states = await Promise.all(offsets.map(async (offset) => await stateAt(path, offset)))
    if (states.every((state) => state === FUSE_DISABLED)) return 'off'
    if (states.every((state) => state === FUSE_ENABLED)) return 'on'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

let memo: Promise<FileProtocolFuse> | undefined

/** What the running binary says, read once on first call. */
export async function fileProtocolFuse (): Promise<FileProtocolFuse> {
  memo ??= readFileProtocolFuse(fuseFilePath(process.execPath))
  return await memo
}
