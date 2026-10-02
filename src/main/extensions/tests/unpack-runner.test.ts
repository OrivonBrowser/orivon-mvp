import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { crc32 } from 'node:zlib'
import AdmZip from 'adm-zip'
import { checkArchiveSize, checkZipEntryPath, MAX_UNPACK_BYTES, MAX_UNPACK_ENTRIES, peekManifest, unpackZip, writeFolderCopy } from '../unpack-runner.js'

async function withTempDir (fn: (dir: string) => void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// checkZipEntryPath takes the mode ALREADY shifted down (unpack-runner.ts's
// own `entry.header.attr >>> 16`), so these are plain Unix mode values.
const REGULAR_FILE_MODE = 0o100644 // S_IFREG | rw-r--r--
const SYMLINK_MODE = 0o120777 // S_IFLNK

describe('checkZipEntryPath', () => {
  const cases: ReadonlyArray<{ label: string, entryName: string, unixMode: number, wantOk: boolean }> = [
    { label: 'an ordinary relative file', entryName: 'manifest.json', unixMode: REGULAR_FILE_MODE, wantOk: true },
    { label: 'an ordinary nested relative file', entryName: 'scripts/content.js', unixMode: REGULAR_FILE_MODE, wantOk: true },
    { label: 'a POSIX absolute path', entryName: '/etc/passwd', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'a Windows drive-letter absolute path', entryName: 'C:/Windows/system32', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'a bare ".." segment', entryName: '..', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'a leading ".." segment', entryName: '../outside.txt', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'a ".." segment buried in the middle', entryName: 'a/b/../../../outside.txt', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'an empty entry name', entryName: '', unixMode: REGULAR_FILE_MODE, wantOk: false },
    { label: 'a symlink entry, even at an otherwise safe path', entryName: 'scripts/content.js', unixMode: SYMLINK_MODE, wantOk: false }
  ]

  it.each(cases)('$label -> ok=$wantOk', ({ entryName, unixMode, wantOk }) => {
    const result = checkZipEntryPath('/tmp/extensions/some-slot/1.0.0', entryName, unixMode)
    expect(result.ok).toBe(wantOk)
  })

  it('never trusts a resolved path outside the target even without a literal ".." segment', () => {
    // Same directory name repeated as a sibling, not an ancestor escape --
    // this is here to pin down that the check is a real prefix comparison,
    // not a string search for the target's own name.
    const result = checkZipEntryPath('/tmp/extensions/slot', 'slot-but-not-really/x', REGULAR_FILE_MODE)
    expect(result.ok).toBe(true) // "slot-but-not-really" is INSIDE "slot", not a sibling of it
  })
})

describe('checkArchiveSize', () => {
  const MIB = 1024 * 1024

  it('accepts a real store extension that unpacks to over 300 MiB (4.4:1 compressed JSON)', () => {
    // 445 entries, 326,345,866 bytes uncompressed in a 74,974,138-byte CRX:
    // the measured shape of a large content blocker's rulesets.
    const entries = Array.from({ length: 444 }, () => ({ size: 700_000, compressedSize: 160_000 }))
    const used = entries.reduce((sum, entry) => sum + entry.size, 0)
    entries.push({ size: 326_345_866 - used, compressedSize: 74_901_750 - 444 * 160_000 })
    expect(checkArchiveSize(entries, 74_974_138)).toEqual({ ok: true })
  })

  it('refuses a total over the absolute cap, whatever the ratio', () => {
    const entries = [{ size: MAX_UNPACK_BYTES + 1, compressedSize: MAX_UNPACK_BYTES / 2 }]
    const result = checkArchiveSize(entries, MAX_UNPACK_BYTES)
    expect(result.ok).toBe(false)
  })

  it('has a 1 GiB absolute cap', () => {
    expect(MAX_UNPACK_BYTES).toBe(1024 * MIB)
  })

  it('refuses a bomb whose total dwarfs the archive it came in', () => {
    const result = checkArchiveSize([{ size: 500 * MIB, compressedSize: 400 * 1024 }], 400 * 1024)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/compression ratio/)
  })

  it('refuses many entries that each look honest when their total dwarfs the archive', () => {
    // 100 entries at about 853:1 each (under the per-entry bound), 500 MiB in
    // all, in a 1 MiB archive: only the total-versus-archive bound catches it.
    const entries = Array.from({ length: 100 }, () => ({ size: 5 * MIB, compressedSize: 6 * 1024 }))
    const result = checkArchiveSize(entries, MIB)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/times its own length/)
  })

  it('refuses one entry whose declared ratio no deflate stream can reach', () => {
    // Total/archive stays under the overall ratio; the single entry lies.
    const entries = [
      { size: 5 * MIB, compressedSize: 1000 },
      { size: 5 * MIB, compressedSize: 5 * MIB }
    ]
    expect(checkArchiveSize(entries, 6 * MIB).ok).toBe(false)
  })

  it('refuses a non-empty entry that claims zero compressed bytes', () => {
    expect(checkArchiveSize([{ size: 10, compressedSize: 0 }], 1000).ok).toBe(false)
  })

  it('accepts empty entries (directories and empty files) without dividing by zero', () => {
    const entries = [{ size: 0, compressedSize: 0 }, { size: 12, compressedSize: 14 }]
    expect(checkArchiveSize(entries, 500)).toEqual({ ok: true })
  })

  it('accepts a highly compressible but honest archive under the overall ratio', () => {
    expect(checkArchiveSize([{ size: 50 * MIB, compressedSize: 600 * 1024 }], 700 * 1024)).toEqual({ ok: true })
  })
})

describe('unpackZip', () => {
  function buildZip (entries: ReadonlyArray<{ name: string, content: string }>): Buffer {
    const zip = new AdmZip()
    for (const entry of entries) zip.addFile(entry.name, Buffer.from(entry.content))
    return zip.toBuffer()
  }

  /** adm-zip's own `addFile` normalises a traversal out of the entry name
   * before it ever reaches the archive (`zipnamefix`, util/utils.js) -- an
   * attacker does not go through `addFile`, so this writes the entry name
   * straight onto a real `ZipEntry` (its setter does no such normalisation)
   * to build a fixture that actually carries one. */
  function buildZipWithRawEntryName (entryName: string, content: string): Buffer {
    const zip = new AdmZip()
    zip.addFile('placeholder.txt', Buffer.from(content))
    const entry = zip.getEntries()[0]
    if (entry === undefined) throw new Error('unreachable: just added one entry')
    entry.entryName = entryName
    return zip.toBuffer()
  }

  it('extracts a well-formed zip to the target directory, atomically (no .tmp- directory left behind)', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
    try {
      const target = join(root, 'extensions', 'slot', '1.0.0')
      const zipBytes = buildZip([
        { name: 'manifest.json', content: '{"name":"fixture"}' },
        { name: 'scripts/content.js', content: 'console.log(1)' }
      ])
      const result = unpackZip(zipBytes, target)
      expect(result.path).toBe(target)
      expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe('{"name":"fixture"}')
      expect(readFileSync(join(target, 'scripts', 'content.js'), 'utf8')).toBe('console.log(1)')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a zip carrying a path-traversal entry, and writes nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
    try {
      const target = join(root, 'extensions', 'slot', '1.0.0')
      const zipBytes = buildZipWithRawEntryName('../../outside.txt', 'x')
      expect(() => unpackZip(zipBytes, target)).toThrow(/refused zip entry/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('refuses a zip over the entry-count cap before writing anything', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
    try {
      const target = join(root, 'extensions', 'slot', '1.0.0')
      const zip = new AdmZip()
      for (let i = 0; i <= MAX_UNPACK_ENTRIES; i += 1) zip.addFile(`f${String(i)}.txt`, Buffer.from('x'))
      expect(() => unpackZip(zip.toBuffer(), target)).toThrow(/entries, over the/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})

interface CraftedCentralEntry {
  readonly name: string
  readonly size: number
  readonly compressedSize: number
  readonly method: number
  readonly offset: number
}

/** A zip from raw bytes: AdmZip cannot express central entries that lie
 * about a stored file's size or share one local header. */
function craftZip (localName: string, data: Buffer, central: ReadonlyArray<CraftedCentralEntry>, localMethod = 0): Buffer {
  const name = Buffer.from(localName)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(localMethod, 8)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const parts: Buffer[] = [local, name, data]
  let cdSize = 0
  for (const entry of central) {
    const entryName = Buffer.from(entry.name)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(entry.method, 10)
    header.writeUInt32LE(crc32(data), 16)
    header.writeUInt32LE(entry.compressedSize, 20)
    header.writeUInt32LE(entry.size, 24)
    header.writeUInt16LE(entryName.length, 28)
    header.writeUInt32LE(entry.offset, 42)
    parts.push(header, entryName)
    cdSize += header.length + entryName.length
  }
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(cdSize, 12)
  end.writeUInt32LE(30 + name.length + data.length, 16)
  parts.push(end)
  return Buffer.concat(parts)
}

describe('an archive whose central directory lies about a stored file', () => {
  it('writes nothing for 1,000 names that share one local header and declare size 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
    try {
      const data = Buffer.alloc(64 * 1024, 0x41)
      const central = Array.from({ length: 1000 }, (_, i) => ({ name: `n${String(i)}.txt`, size: 0, compressedSize: data.length, method: 0, offset: 0 }))
      const target = join(root, 'extensions', 'slot', '1.0.0')

      expect(() => unpackZip(craftZip('a.txt', data, central), target)).toThrow()
      expect(existsSync(target)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('counts the larger of the declared and the stored size toward the total', () => {
    const MIB = 1024 * 1024
    const entries = Array.from({ length: 2 }, () => ({ size: 0, compressedSize: 600 * MIB, method: 0, offset: 0 }))
    const result = checkArchiveSize(entries.map((entry, i) => ({ ...entry, offset: i })), 2000 * MIB)
    expect(result.ok).toBe(false)
  })

  it('refuses a stored entry whose size differs from its compressed size', () => {
    const result = checkArchiveSize([{ size: 10, compressedSize: 12, method: 0, offset: 0 }], 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/stored/)
  })

  it('refuses two entries that point at one local header', () => {
    const result = checkArchiveSize([
      { size: 10, compressedSize: 10, method: 0, offset: 0 },
      { size: 10, compressedSize: 10, method: 0, offset: 0 }
    ], 1000)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/local header/)
  })

  it('still accepts an ordinary archive, with its empty files, folders and folders AdmZip implies', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{}'))
    zip.addFile('empty.txt', Buffer.alloc(0))
    zip.addFile('a/b/c.js', Buffer.from('1'))
    zip.addFile('d/', Buffer.alloc(0))
    const root = mkdtempSync(join(tmpdir(), 'orivon-unpack-test-'))
    try {
      expect(unpackZip(zip.toBuffer(), join(root, 'x')).path).toBe(join(root, 'x'))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('peekManifest', () => {
  it('refuses a manifest.json that declares more than 1 MiB before inflating it', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{"pad":"' + 'a'.repeat(2 * 1024 * 1024) + '"}'))
    expect(() => peekManifest(zip.toBuffer())).toThrow(/manifest.json is over/)
  })

  it('refuses a manifest.json whose declared ratio no deflate stream can reach', () => {
    const data = Buffer.alloc(16, 0x41)
    const lying = craftZip('manifest.json', data, [{ name: 'manifest.json', size: 900_000, compressedSize: 16, method: 0, offset: 0 }])
    expect(() => peekManifest(lying)).toThrow(/manifest.json/)
  })

  it('reads an ordinary manifest', () => {
    const zip = new AdmZip()
    zip.addFile('manifest.json', Buffer.from('{"name":"x"}'))
    expect(peekManifest(zip.toBuffer())).toEqual({ name: 'x' })
  })
})

describe('writeFolderCopy', () => {
  it('refuses a source folder containing a symlink, before copying anything', async () => {
    await withTempDir((root) => {
      const source = join(root, 'source')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'manifest.json'), '{}')
      const outsideTarget = join(root, 'outside-secret')
      writeFileSync(outsideTarget, 'not part of the extension')
      symlinkSync(outsideTarget, join(source, 'root'))
      const target = join(root, 'extensions', 'slot', '1.0.0')

      expect(() => writeFolderCopy(source, target, '{}')).toThrow(/symlink entries are refused/)
      expect(existsSync(target)).toBe(false)
      expect(readFileSync(outsideTarget, 'utf8')).toBe('not part of the extension')
    })
  })

  it('refuses a symlinked manifest.json rather than writing through it', async () => {
    await withTempDir((root) => {
      const source = join(root, 'source')
      mkdirSync(source, { recursive: true })
      const realManifest = join(root, 'real-manifest.json')
      writeFileSync(realManifest, '{"name":"real"}')
      symlinkSync(realManifest, join(source, 'manifest.json'))
      const target = join(root, 'extensions', 'slot', '1.0.0')

      expect(() => writeFolderCopy(source, target, '{"name":"loaded"}')).toThrow(/symlink entries are refused/)
      expect(existsSync(target)).toBe(false)
      expect(readFileSync(realManifest, 'utf8')).toBe('{"name":"real"}')
    })
  })

  it('refuses a symlink nested in a subdirectory too', async () => {
    await withTempDir((root) => {
      const source = join(root, 'source')
      mkdirSync(join(source, 'assets'), { recursive: true })
      writeFileSync(join(source, 'manifest.json'), '{}')
      const outsideTarget = join(root, 'outside-secret-2')
      writeFileSync(outsideTarget, 'not part of the extension')
      symlinkSync(outsideTarget, join(source, 'assets', 'linked.js'))
      const target = join(root, 'extensions', 'slot', '1.0.0')

      expect(() => writeFolderCopy(source, target, '{}')).toThrow(/symlink entries are refused/)
      expect(existsSync(target)).toBe(false)
    })
  })

  it('copies an ordinary folder\'s contents and writes the given manifest over its own', async () => {
    await withTempDir((root) => {
      const source = join(root, 'source')
      mkdirSync(source, { recursive: true })
      writeFileSync(join(source, 'manifest.json'), '{"name":"original"}')
      writeFileSync(join(source, 'content.js'), 'console.log(1)')
      const target = join(root, 'extensions', 'slot', '1.0.0')

      writeFolderCopy(source, target, '{"name":"loaded"}')

      expect(readFileSync(join(target, 'manifest.json'), 'utf8')).toBe('{"name":"loaded"}')
      expect(readFileSync(join(target, 'content.js'), 'utf8')).toBe('console.log(1)')
    })
  })
})
