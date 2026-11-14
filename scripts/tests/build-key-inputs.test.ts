// test:changed reads src/ vendor/ resources/ scripts/ electron.vite.config.ts
import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, posix } from 'node:path'
import { BUILD_INPUTS } from '../build-key.mjs'
import { trackedFiles } from '../cli.mjs'

const root = process.cwd()
const CODE = /\.(?:ts|tsx|mts|mjs|js|html|css)$/
const TEST_FILE = /(?:^|\/)tests?\/|\.test\.|\.test-helpers\./
/** A relative specifier or URL in code: `from '../x'`, `import('./y')`, `require('./z')`, `new URL('./w', import.meta.url)`, `src="./a.js"`, `url(../b.png)`. */
const RELATIVE = /(?:from\s+|import\s*\(\s*|import\s+|require\(\s*|new\s+URL\(\s*|href=|src=|url\()['"]?(\.{1,2}\/[^'")\s]+)/g
/** The config's `resolve(root, 'dir/file')` calls, which may span lines. */
const FROM_ROOT = /resolve\(\s*root,\s*'([^']+)'/g

const covered = (path: string): boolean => BUILD_INPUTS.some((input) => path === input || path.startsWith(`${input}/`))
/** An import names `./x.js` for the `./x.ts` beside it, and a comment may say `./chunks/...`. */
const reachable = (path: string): boolean => path.includes('...') || covered(path) || covered(path.replace(/\.js$/, '.ts'))

/** Paths of files that `file` names and the build would read (a folder named as a base for other paths is no read), root-relative with forward slashes. */
function readsOf (file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const here = dirname(file)
  const specifiers = [...text.matchAll(RELATIVE)].map((match) => (match[1] ?? '').split('?')[0] ?? '').filter((specifier) => !specifier.endsWith('/'))
  const found = specifiers.map((specifier) => posix.normalize(posix.join(here, specifier)))
  if (file === 'electron.vite.config.ts') found.push(...[...text.matchAll(FROM_ROOT)].map((match) => posix.normalize(match[1] ?? '')))
  return found
}

describe('BUILD_INPUTS', () => {
  const files = [
    'electron.vite.config.ts',
    ...trackedFiles(root).filter((file) => covered(file) && CODE.test(file) && !TEST_FILE.test(file))
  ]

  it('names a path that exists, each', () => {
    const tracked = trackedFiles(root)
    for (const input of BUILD_INPUTS) {
      expect(tracked.some((file) => file === input || file.startsWith(`${input}/`)), input).toBe(true)
    }
  })

  it('holds every file that a file of the build names, so the key sees an edit to it', () => {
    const outside = files.flatMap((file) => readsOf(file).filter((path) => !reachable(path)).map((path) => `${file} -> ${path}`))
    expect(outside, 'add the path to BUILD_INPUTS in scripts/build-key.mjs').toEqual([])
  })

  it('holds only files git lists, never one it ignores', () => {
    const tracked = new Set(trackedFiles(root))
    const ignored = (path: string): boolean => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--', path], { cwd: root, stdio: 'ignore' })
        return true
      } catch {
        return false
      }
    }
    const onDisk = (path: string): string | undefined => [path, path.replace(/\.js$/, '.ts')].find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
    const hidden = files.flatMap((file) => readsOf(file).filter((path) => reachable(path) && !path.includes('...')).flatMap((path) => {
      const found = onDisk(path)
      return found !== undefined && !tracked.has(found) && ignored(found) ? [`${file} -> ${found}`] : []
    }))
    expect(hidden, 'the key never sees a file git ignores').toEqual([])
  })

  it('holds the scripts the build configuration imports', () => {
    const imported = [...readFileSync('electron.vite.config.ts', 'utf8').matchAll(/from '\.\/(scripts\/[^']+?)(?:\.js)?'/g)].map((match) => match[1] ?? '')
    expect(imported.length).toBeGreaterThan(0)
    for (const script of imported) expect(covered(`${script}.ts`), script).toBe(true)
  })
})
