import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import AdmZip from 'adm-zip'
import { checkZipEntryPath, MAX_UNPACK_ENTRIES, unpackZip } from '../unpack-runner.js'

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
