import { describe, expect, it } from 'vitest'
import { posix } from 'node:path'
import { CONFINEMENT_ERROR_CODE, confinePath } from './paths.js'
import type { ConfineDenialReason } from './paths.js'

// Every row here is a compromise if it flips. T1/T10 in security-model.md:
// "a silent bug here is a full compromise". The two rows that matter most,
// because they are the ones a plausible wrong implementation gets wrong:
//
//   - `foo-evil` vs root `foo`. A startsWith() check accepts it.
//   - the symlink rows. A path.resolve() check accepts them.
//
// The Windows rows run on Linux CI and still mean something, because
// confinePath picks its path flavour from the shape of the root rather than
// from process.platform. Windows and macOS are supported run-from-source
// targets that nothing in CI ever executes.

const ROOT = '/apps/foo'
const WIN_ROOT = 'C:\\apps\\foo'

/** Everything exists; nothing is a symlink. */
const identityRealpath = (p: string): string => p

/**
 * Stands in for fs.realpathSync.
 *
 * `links` maps a path to what it canonicalises to, and the mapping applies to
 * descendants as well -- which is what a real symlink does: if `root/link`
 * points at `/etc`, then `root/link/passwd` really is `/etc/passwd`.
 * `absent` throws for a path and everything under it, the way realpath does
 * for a file not created yet.
 */
function realpathStub (
  links: Readonly<Record<string, string>> = {},
  absent: readonly string[] = []
): (p: string) => string {
  const isUnder = (p: string, base: string): boolean =>
    p === base || p.startsWith(`${base}/`) || p.startsWith(`${base}\\`)

  return (p) => {
    if (absent.some((base) => isUnder(p, base))) {
      throw new Error(`ENOENT: no such file or directory, lstat '${p}'`)
    }
    for (const [from, to] of Object.entries(links)) {
      if (p === from) return to
      if (isUnder(p, from)) return to + p.slice(from.length)
    }
    return p
  }
}

describe('confinePath', () => {
  describe('accepts paths inside the root', () => {
    it.each([
      ['a plain file', 'a.txt', '/apps/foo/a.txt'],
      ['a nested file', 'sub/dir/file.mkv', '/apps/foo/sub/dir/file.mkv'],
      ['a leading ./', './a.txt', '/apps/foo/a.txt'],
      ['a .. that stays inside', 'a/../b.txt', '/apps/foo/b.txt'],
      ['a deep .. that stays inside', 'a/b/c/../../d.txt', '/apps/foo/a/d.txt'],
      ['redundant separators', 'a//b.txt', '/apps/foo/a/b.txt'],
      ['spaces in a name', 'Show/Season 1/ep.mkv', '/apps/foo/Show/Season 1/ep.mkv'],
      ['non-ASCII in a name', 'films/Amélie.mkv', '/apps/foo/films/Amélie.mkv'],
      ['a name that merely starts with dots', '..bar', '/apps/foo/..bar'],
      ['a dotfile', '.config', '/apps/foo/.config'],
      // Inside the root, a file may be NAMED anything -- including the thing
      // that would be an escape one level up. Only the location matters.
      ['a file named like the evil sibling', 'foo-evil', '/apps/foo/foo-evil']
    ])('%s', (_label, requested, expected) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({
        ok: true,
        resolved: expected
      })
    })

    it('a trailing slash on the root does not change the answer', () => {
      expect(confinePath('/apps/foo/', 'a.txt', identityRealpath)).toEqual({
        ok: true,
        resolved: '/apps/foo/a.txt'
      })
    })

    it('accepts a path whose directories do not exist yet', () => {
      // The flagship's own happy path: a torrent declares Show/Season 1/ep.mkv
      // and none of those directories have been created. A check that gave up
      // at the first missing component would reject every new download.
      const realpath = realpathStub({}, ['/apps/foo/Show'])
      expect(confinePath(ROOT, 'Show/Season 1/ep.mkv', realpath)).toEqual({
        ok: true,
        resolved: '/apps/foo/Show/Season 1/ep.mkv'
      })
    })

    it('accepts a symlink that stays inside the root', () => {
      const realpath = realpathStub({ '/apps/foo/link': '/apps/foo/real' })
      expect(confinePath(ROOT, 'link/a.txt', realpath)).toEqual({
        ok: true,
        resolved: '/apps/foo/link/a.txt'
      })
    })

    it('accepts when the ROOT itself is behind a symlink (macOS /var -> /private/var)', () => {
      // Regression guard. Comparing a canonicalised descendant against a raw
      // root denies every path an app ever asks for, and only on macOS --
      // which no CI job runs. confinePath canonicalises the root too.
      const macRoot = '/var/folders/orivon/apps/abc'
      const realpath = realpathStub({ '/var': '/private/var' })
      expect(confinePath(macRoot, 'films/a.mkv', realpath)).toEqual({
        ok: true,
        resolved: '/var/folders/orivon/apps/abc/films/a.mkv'
      })
    })
  })

  describe('rejects .. traversal', () => {
    it.each([
      '..',
      '../',
      '../etc/passwd',
      '../../../../etc/passwd',
      '../../../.ssh/authorized_keys',
      'a/../../etc/passwd',
      'a/b/../../../etc/passwd',
      'sub/../../..',
      './../../etc/passwd'
    ])('rejects %s', (requested) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({
        ok: false,
        reason: 'escapes-root'
      })
    })
  })

  describe('rejects the sibling-prefix escape', () => {
    // THE reason path.relative is used instead of startsWith. /apps/foo-evil
    // shares every character of the /apps/foo prefix and is a different app's
    // directory. A prefix check hands one app the other's files.
    it('rejects ../foo-evil/secret, which shares the root string prefix', () => {
      expect(confinePath(ROOT, '../foo-evil/secret', identityRealpath)).toEqual({
        ok: false,
        reason: 'escapes-root'
      })
    })

    it('rejects a symlink that lands in the prefix-sharing sibling', () => {
      // Same trap, reached through check 2 instead of check 1: the canonical
      // path /apps/foo-evil/x also passes a startsWith('/apps/foo') test.
      const realpath = realpathStub({ '/apps/foo/x': '/apps/foo-evil/x' })
      expect(confinePath(ROOT, 'x', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })
  })

  describe('rejects absolute paths', () => {
    it.each([
      '/etc/passwd',
      '/etc/shadow',
      '/',
      '//server/share/x',
      // Rejected even though it points INSIDE the root. Absolute input is not
      // re-rooted or trusted; handle-contracts.md SSFileHandle says reject.
      '/apps/foo/a.txt'
    ])('rejects %s', (requested) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({
        ok: false,
        reason: 'absolute'
      })
    })
  })

  describe('rejects symlink escapes (check 2 -- path.resolve cannot see these)', () => {
    it('rejects a link whose target is outside the root', () => {
      const realpath = realpathStub({ '/apps/foo/link': '/etc' })
      expect(confinePath(ROOT, 'link/passwd', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })

    it('rejects when the LEAF itself is the link', () => {
      const realpath = realpathStub({ '/apps/foo/passwd': '/etc/passwd' })
      expect(confinePath(ROOT, 'passwd', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })

    it('rejects a link found while walking up, with a not-yet-created leaf', () => {
      const realpath = realpathStub(
        { '/apps/foo/out': '/home/victim' },
        ['/apps/foo/out/deep']
      )
      expect(confinePath(ROOT, 'out/deep/file.txt', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })

    it('rejects a link whose target is the root of the filesystem', () => {
      const realpath = realpathStub({ '/apps/foo/link': '/' })
      expect(confinePath(ROOT, 'link/etc/passwd', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })
  })

  describe('rejects NUL bytes', () => {
    it.each([
      ['a bare NUL', '\u0000'],
      ['a NUL between segments', 'a\u0000b'],
      // The poison null byte: an extension check upstream sees .jpg, the C
      // library underneath opens secret.txt.
      ['a truncating NUL', 'secret.txt\u0000.jpg'],
      ['a NUL in a directory name', 'sub\u0000/a.txt']
    ])('rejects %s', (_label, requested) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({
        ok: false,
        reason: 'nul-byte'
      })
    })

    it('rejects a NUL in the root as well', () => {
      expect(confinePath('/apps/fo\u0000o', 'a.txt', identityRealpath)).toEqual({
        ok: false,
        reason: 'nul-byte'
      })
    })
  })

  describe('rejects Windows separators, drives and UNC paths on every platform', () => {
    it.each([
      ['a drive-absolute path', 'C:\\Windows\\System32', 'windows-drive'],
      ['a drive with forward slashes', 'C:/Windows/System32', 'windows-drive'],
      // Drive-RELATIVE. Win32 resolves this against the per-drive working
      // directory, which is process state this function must never consult.
      ['a drive-relative path', 'C:secret.txt', 'windows-drive'],
      ['a lowercase drive', 'd:/secrets', 'windows-drive'],
      ['backslash traversal', '..\\..\\Windows\\System32', 'backslash'],
      ['a backslash separator', 'sub\\a.txt', 'backslash'],
      ['a UNC share', '\\\\server\\share\\x', 'backslash'],
      // \\?\ turns off Win32 path normalisation entirely, including the
      // reserved-name and trailing-dot rules everything else relies on.
      ['a \\\\?\\ extended path', '\\\\?\\C:\\Windows\\System32', 'backslash'],
      ['a \\\\.\\ device path', '\\\\.\\PhysicalDrive0', 'backslash']
    ])('rejects %s', (_label, requested, reason) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({ ok: false, reason })
    })
  })

  describe('rejects Windows reserved device names', () => {
    it.each([
      'CON',
      'PRN',
      'AUX',
      'NUL',
      'COM1',
      'COM9',
      'LPT1',
      'LPT9',
      // Case, extension, trailing dot and trailing space are all stripped by
      // Win32 before it looks the name up, so all of these reach the device.
      'con',
      'NuL',
      'CON.txt',
      'nul.log',
      'CON.',
      'CON ',
      // An interior segment counts: the directory cannot be created either.
      'sub/CON',
      'sub/NUL/a.txt'
    ])('rejects %s', (requested) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({
        ok: false,
        reason: 'reserved-name'
      })
    })

    it.each(['CONSOLE', 'CONFIG.json', '.CON', 'COM0', 'LPT10', 'my-con', 'NULL.txt'])(
      'accepts %s, which merely looks reserved',
      (requested) => {
        const result = confinePath(ROOT, requested, identityRealpath)
        expect(result.ok).toBe(true)
      }
    )
  })

  describe('with a Windows root (flavour comes from the root, not the host OS)', () => {
    it('accepts a plain file', () => {
      expect(confinePath(WIN_ROOT, 'a.txt', identityRealpath)).toEqual({
        ok: true,
        resolved: 'C:\\apps\\foo\\a.txt'
      })
    })

    it('treats a forward slash as a separator, as Win32 does', () => {
      expect(confinePath(WIN_ROOT, 'sub/a.txt', identityRealpath)).toEqual({
        ok: true,
        resolved: 'C:\\apps\\foo\\sub\\a.txt'
      })
    })

    it('rejects .. traversal', () => {
      expect(confinePath(WIN_ROOT, '../../Windows/System32', identityRealpath)).toEqual({
        ok: false,
        reason: 'escapes-root'
      })
    })

    it('rejects the prefix-sharing sibling', () => {
      expect(confinePath(WIN_ROOT, '../foo-evil/secret', identityRealpath)).toEqual({
        ok: false,
        reason: 'escapes-root'
      })
    })

    it('rejects a junction pointing at another drive', () => {
      // This is the row that needs path.isAbsolute in the escape test.
      // win32.relative('C:\\apps\\foo', 'D:\\secrets\\x') === 'D:\\secrets\\x'
      // -- there is no `..` anywhere in it, because no relative path can
      // express crossing a drive.
      const realpath = realpathStub({ 'C:\\apps\\foo\\j': 'D:\\secrets' })
      expect(confinePath(WIN_ROOT, 'j/x', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })

    it('accepts a file under a UNC root', () => {
      expect(
        confinePath('\\\\server\\share\\apps\\foo', 'a.txt', identityRealpath)
      ).toEqual({ ok: true, resolved: '\\\\server\\share\\apps\\foo\\a.txt' })
    })
  })

  describe('case sensitivity (macOS and Windows volumes are case-insensitive)', () => {
    it('rejects a sibling that differs from the root only by case', () => {
      // Fail closed. On a case-insensitive volume /apps/FOO is the same
      // directory as /apps/foo, but on ext4 it is a different one, and the
      // rule must not depend on which filesystem the user happens to have.
      expect(confinePath(ROOT, '../FOO/secret', identityRealpath)).toEqual({
        ok: false,
        reason: 'escapes-root'
      })
    })

    it('rejects a symlink resolving to a case-variant of the root', () => {
      const realpath = realpathStub({ '/apps/foo/x': '/apps/FOO/x' })
      expect(confinePath(ROOT, 'x', realpath)).toEqual({
        ok: false,
        reason: 'symlink-escape'
      })
    })

    it('keeps case within a filename, which is not the same question', () => {
      expect(confinePath(ROOT, 'MyFile.TXT', identityRealpath)).toEqual({
        ok: true,
        resolved: '/apps/foo/MyFile.TXT'
      })
    })
  })

  describe('rejects degenerate input', () => {
    it.each<[string, string, ConfineDenialReason]>([
      ['an empty request', '', 'empty'],
      ['whitespace only', '   ', 'empty'],
      ['a tab', '\t', 'empty'],
      ['the root itself', '.', 'is-root'],
      ['the root reached by ..', 'a/..', 'is-root'],
      ['the root with a trailing slash', './', 'is-root']
    ])('rejects %s', (_label, requested, reason) => {
      expect(confinePath(ROOT, requested, identityRealpath)).toEqual({ ok: false, reason })
    })

    it.each(['relative/root', '', 'C:relative'])(
      'rejects the non-absolute root %s before checking anything else',
      (root) => {
        expect(confinePath(root, 'a.txt', identityRealpath)).toEqual({
          ok: false,
          reason: 'root-not-absolute'
        })
      }
    )

    it('rejects when the root cannot be canonicalised', () => {
      const realpath = realpathStub({}, [ROOT])
      expect(confinePath(ROOT, 'a.txt', realpath)).toEqual({
        ok: false,
        reason: 'root-unresolvable'
      })
    })

    it('rejects when realpath returns a relative path', () => {
      // A broken injection must fail closed rather than have its answer
      // resolved against a working directory this function never reads.
      expect(confinePath(ROOT, 'a.txt', () => 'not/absolute')).toEqual({
        ok: false,
        reason: 'root-unresolvable'
      })
    })

    it('rejects when realpath returns a relative path for a descendant only', () => {
      const realpath = (p: string): string => (p === ROOT ? p : 'not/absolute')
      expect(confinePath(ROOT, 'a.txt', realpath)).toEqual({
        ok: false,
        reason: 'unresolvable'
      })
    })
  })

  it('reports every denial to the app as the single code `denied`', () => {
    // contracts/errors.ts: denials that varied by reason would let an app map
    // the filesystem outside its root one probe at a time. The reason field
    // is for the broker's local log and must not cross the IPC boundary.
    expect(CONFINEMENT_ERROR_CODE).toBe('denied')
  })
})

// fast-check is not a devDependency and the task forbids adding one, so this
// is the same idea by hand: a deterministic generator, a fixed seed so a
// failure is reproducible, and the input printed in the assertion message.
//
// Two properties, because either alone is passed by a broken implementation:
// "never escapes" is satisfied by a function that rejects everything, and
// "always accepts safe input" is satisfied by one that accepts everything.

/** xorshift32. Deterministic, seeded, and never reaches 0 from a non-zero seed. */
function makeRandom (seed: number): () => number {
  let state = seed | 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x1_0000_0000
  }
}

function pick<T> (pool: readonly T[], random: () => number): T {
  const item = pool[Math.floor(random() * pool.length)]
  if (item === undefined) throw new Error('empty pool')
  return item
}

const HOSTILE_SEGMENTS = [
  '..', '.', '', 'a', 'sub', 'x.txt', 'foo bar', 'ünïcødé',
  '-evil', 'foo-evil', '..bar', 'CON', '...'
] as const

const SAFE_SEGMENTS = [
  'a', 'b', 'sub', 'x.txt', 'foo bar', 'ünïcødé', '-evil', 'foo-evil', '..bar', 'Season 1'
] as const

const ITERATIONS = 2000

describe('property: the resolved path is always inside the root', () => {
  it('never returns a path outside the root, over generated segment arrays', () => {
    const random = makeRandom(20260826)

    for (let i = 0; i < ITERATIONS; i++) {
      const length = 1 + Math.floor(random() * 6)
      const segments = Array.from({ length }, () => pick(HOSTILE_SEGMENTS, random))
      const requested = segments.join('/')

      const result = confinePath(ROOT, requested, identityRealpath)
      if (!result.ok) continue

      const rel = posix.relative(ROOT, result.resolved)
      const inside =
        result.resolved.startsWith(`${ROOT}/`) &&
        rel !== '' &&
        rel !== '..' &&
        !rel.startsWith('../') &&
        !posix.isAbsolute(rel)

      expect(inside, `escaped on ${JSON.stringify(requested)} -> ${result.resolved}`).toBe(
        true
      )
    }
  })

  it('always accepts a path built only from safe segments', () => {
    // The over-rejection half. Without it, `return { ok: false }` passes the
    // property above for every input.
    const random = makeRandom(70017)

    for (let i = 0; i < ITERATIONS; i++) {
      const length = 1 + Math.floor(random() * 6)
      const segments = Array.from({ length }, () => pick(SAFE_SEGMENTS, random))
      const requested = segments.join('/')

      const result = confinePath(ROOT, requested, identityRealpath)

      expect(result.ok, `wrongly rejected ${JSON.stringify(requested)}`).toBe(true)
      if (result.ok) {
        expect(result.resolved).toBe(`${ROOT}/${segments.join('/')}`)
      }
    }
  })
})
