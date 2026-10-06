import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FuseV1Options, FuseVersion } from '@electron/fuses'
import { FuseState, SENTINEL as FUSES_SENTINEL } from '@electron/fuses/dist/constants'
import {
  FILE_PROTOCOL_FUSE_INDEX,
  FUSE_DISABLED,
  FUSE_ENABLED,
  FUSE_REMOVED,
  FUSE_SENTINEL,
  fuseFilePath,
  readFileProtocolFuse
} from '../file-fuse'

/** A binary-shaped file: filler, the sentinel, a version byte, a length byte and the wire. */
function binaryWith (wires: number[][], opts: { version?: number, filler?: number } = {}): Buffer {
  const parts: Buffer[] = []
  for (const wire of wires) {
    parts.push(Buffer.alloc(opts.filler ?? 100, 0x41))
    parts.push(Buffer.from(FUSE_SENTINEL), Buffer.from([opts.version ?? 1, wire.length, ...wire]))
  }
  parts.push(Buffer.alloc(50, 0x42))
  return Buffer.concat(parts)
}

const wireWith = (state: number): number[] => [48, 49, 48, 48, 49, 49, 48, state]

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'orivon-file-fuse-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

async function fileWith (bytes: Buffer): Promise<string> {
  const path = join(dir, 'electron')
  await writeFile(path, bytes)
  return path
}

describe('constants', () => {
  it('equal the ones @electron/fuses ships', () => {
    expect(FUSE_SENTINEL).toBe(FUSES_SENTINEL)
    expect(FILE_PROTOCOL_FUSE_INDEX).toBe(FuseV1Options.GrantFileProtocolExtraPrivileges)
    expect(FUSE_DISABLED).toBe(FuseState.DISABLE)
    expect(FUSE_ENABLED).toBe(FuseState.ENABLE)
    expect(FUSE_REMOVED).toBe(FuseState.REMOVED)
  })
})

describe('readFileProtocolFuse', () => {
  it('reads off from byte 48', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(48)])))).toBe('off')
  })

  it('reads on from byte 49', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(49)])))).toBe('on')
  })

  it('reads a removed fuse (114) as unknown', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(114)])))).toBe('unknown')
  })

  it('finds the sentinel when a chunk boundary falls inside it', async () => {
    const bytes = binaryWith([wireWith(48)], { filler: 1000 })
    for (const chunk of [1000 + 5, 1000 + 1, 1000 + 32, 1000 + 33, 64]) {
      expect(await readFileProtocolFuse(await fileWith(bytes), chunk)).toBe('off')
    }
  })

  it('reads the wire when the chunk ends before it', async () => {
    const bytes = binaryWith([wireWith(49)], { filler: 1000 })
    expect(await readFileProtocolFuse(await fileWith(bytes), 1000 + FUSE_SENTINEL.length)).toBe('on')
  })

  it('is unknown without a sentinel', async () => {
    expect(await readFileProtocolFuse(await fileWith(Buffer.alloc(5000, 0x41)))).toBe('unknown')
  })

  it('is unknown for a wire version it does not know', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(48)], { version: 2 })))).toBe('unknown')
  })

  it('is unknown for a wire too short to hold the fuse', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([[48, 49, 48]])))).toBe('unknown')
  })

  it('is unknown for a wire cut off by the end of the file', async () => {
    const bytes = binaryWith([wireWith(48)])
    const cut = bytes.subarray(0, bytes.indexOf(FUSE_SENTINEL) + FUSE_SENTINEL.length + 5)
    expect(await readFileProtocolFuse(await fileWith(cut))).toBe('unknown')
  })

  it('is off only when every sentinel says off', async () => {
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(48), wireWith(48)])))).toBe('off')
    expect(await readFileProtocolFuse(await fileWith(binaryWith([wireWith(48), wireWith(49)])))).toBe('unknown')
  })

  it('is unknown for a file that is not there', async () => {
    expect(await readFileProtocolFuse(join(dir, 'missing'))).toBe('unknown')
  })

  it('reads a real flipped wire the way @electron/fuses writes it', async () => {
    const { flipFuses } = await import('@electron/fuses')
    const path = await fileWith(binaryWith([wireWith(49)]))
    await flipFuses(path, { version: FuseVersion.V1, [FuseV1Options.GrantFileProtocolExtraPrivileges]: false })
    expect(await readFileProtocolFuse(path)).toBe('off')
  })
})

describe('fuseFilePath', () => {
  it('is the executable itself off macOS', () => {
    expect(fuseFilePath('/opt/orivon/orivon', 'linux')).toBe('/opt/orivon/orivon')
    expect(fuseFilePath('C:\\orivon\\orivon.exe', 'win32')).toBe('C:\\orivon\\orivon.exe')
  })

  it('is the framework binary inside the app bundle on macOS', async () => {
    await mkdir(dir, { recursive: true })
    expect(fuseFilePath('/Applications/Orivon.app/Contents/MacOS/Orivon', 'darwin')).toBe(
      '/Applications/Orivon.app/Contents/Frameworks/Electron Framework.framework/Electron Framework'
    )
  })
})

describe('knownFileProtocolFuse', () => {
  it('is undefined until the fuse has been read, then what the binary says', async () => {
    const { fileProtocolFuse, knownFileProtocolFuse } = await import('../file-fuse')
    expect(knownFileProtocolFuse()).toBeUndefined()

    const answer = await fileProtocolFuse()

    expect(knownFileProtocolFuse()).toBe(answer)
  })
})
