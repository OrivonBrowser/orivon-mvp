// The guard's own tests. It exists because src/main/start.ts ends the browser on any unhandled rejection, so each
// spelling of "start a promise and let it go" is a case of its own, and so is each way of handling one that must
// not be flagged: a guard that flags a handled chain gets switched off, one that misses a spelling protects nothing.
// A fixture project marks the lines that must be reported with `FLAG`; every other line must pass.
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkFloatingPromises, reachableFiles } from '../check-floating-promises.mjs'

const MAIN = `import type { Clipboard, WebContents } from 'electron'
import { later } from './sibling.js'

declare function work (): Promise<number>
declare function plain (): number
declare function handle (error: unknown): void
declare const maybe: Promise<number> | undefined
declare const anything: any
declare const wc: WebContents
declare const clipboard: Clipboard
declare const flag: boolean

export async function cases (): Promise<number> {
  void work() // FLAG
  work() // FLAG
  work().then((n) => n) // FLAG
  work().finally(() => {}) // FLAG
  flag && work() // FLAG
  flag ? work() : undefined // FLAG
  void (async () => { await work() })() // FLAG
  void Promise.all([work()]) // FLAG
  new Promise<void>(() => {}) // FLAG
  maybe?.then((n) => n) // FLAG
  work().catch(handle).then((n) => n) // FLAG
  // orivon:floating-ok
  void work() // FLAG
  void later() // FLAG
  clipboard.write([]) // FLAG

  await work()
  const kept = work()
  void kept.catch(handle)
  work().catch(handle)
  void work().catch(handle)
  work().then((n) => n, handle)
  work().then((n) => n).catch(handle)
  work().catch(handle).finally(() => {})
  void wc.loadURL('https://example.com')
  wc.loadFile('index.html')
  clipboard.writeText('copied')
  await clipboard.write([])
  plain()
  void plain()
  anything.run()
  // orivon:floating-ok -- a stub that never rejects
  void work()
  return await work()
}
`

function project (files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'orivon-floating-'))
  const all: Record<string, string> = {
    'tsconfig.json': JSON.stringify({
      compilerOptions: { target: 'ES2023', lib: ['ES2023'], module: 'ESNext', moduleResolution: 'bundler', strict: true, noEmit: true, types: [] },
      include: ['src/**/*.ts']
    }),
    'node_modules/electron/package.json': JSON.stringify({ name: 'electron', types: 'index.d.ts' }),
    'node_modules/electron/index.d.ts': 'export interface WebContents { loadURL (url: string): Promise<void>; loadFile (path: string): Promise<void> }\nexport interface Clipboard { writeText (text: string): Promise<void>; write (items: unknown[]): Promise<void> }\n',
    ...files
  }
  for (const [name, body] of Object.entries(all)) {
    const full = join(root, name)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

const lines = (text: string, marker: string): number[] =>
  text.split('\n').flatMap((line, index) => (line.includes(marker) ? [index + 1] : []))

describe('what it reports', () => {
  it('flags exactly the unhandled promises of the main-process files', async () => {
    const root = project({
      'src/main/index.ts': MAIN,
      'src/main/sibling.ts': 'export async function later (): Promise<void> {}\nexport function twice (): void {\n  void later() // FLAG\n}\n',
      'src/renderer/page.ts': 'declare function work (): Promise<void>\nvoid work()\n',
      'src/main/tests/x.test.ts': 'declare function work (): Promise<void>\nvoid work()\n'
    })
    const result = await checkFloatingPromises(root, [{ tsconfig: 'tsconfig.json', entries: ['src/main/index.ts'] }])

    expect(result.ok).toBe(false)
    expect(result.findings.filter((f) => f.file === 'src/main/index.ts').map((f) => f.line)).toEqual(lines(MAIN, 'FLAG'))
    expect(result.findings.filter((f) => f.file === 'src/main/sibling.ts').map((f) => f.line)).toEqual([3])
    expect(result.findings.map((f) => f.file)).toEqual(expect.not.arrayContaining(['src/renderer/page.ts', 'src/main/tests/x.test.ts']))
    expect(result.findings[0]).toMatchObject({ file: 'src/main/index.ts', line: lines(MAIN, 'FLAG')[0], text: 'void work()' })
  }, 60_000)

  it('passes a project with nothing floated', async () => {
    const root = project({ 'src/main/index.ts': 'declare function work (): Promise<void>\nexport async function ok (): Promise<void> {\n  await work()\n  void work().catch(() => {})\n}\n' })
    const result = await checkFloatingPromises(root, [{ tsconfig: 'tsconfig.json', entries: ['src/main/index.ts'] }])
    expect(result).toEqual({ ok: true, findings: [] })
  }, 60_000)
})

describe('which files count as the main process', () => {
  const sources: Record<string, string> = {
    '/p/src/main/index.ts': "import { a } from './a.js'\nimport './dir/index.js'\nconst lazy = () => import('../shared/lazy.js')\nimport 'electron'\n",
    '/p/src/main/a.ts': "export { b } from './b.js'\n",
    '/p/src/main/b.ts': "import type { T } from './tests/helper.js'\n",
    '/p/src/main/dir/index.ts': '',
    '/p/src/shared/lazy.ts': '',
    '/p/src/main/tests/helper.ts': '',
    '/p/src/main/orphan.ts': '',
    '/p/src/renderer/ui.ts': "import '../main/orphan.js'\n"
  }
  const known = new Set(Object.keys(sources))

  it('follows relative imports, re-exports and dynamic imports from the entries', () => {
    const reached = reachableFiles(['/p/src/main/index.ts'], known, (file) => sources[file] ?? '')
    expect([...reached].sort()).toEqual(['/p/src/main/a.ts', '/p/src/main/b.ts', '/p/src/main/dir/index.ts', '/p/src/main/index.ts', '/p/src/shared/lazy.ts'])
  })

  it('leaves out tests, and files only the renderer imports', () => {
    const reached = reachableFiles(['/p/src/main/index.ts'], known, (file) => sources[file] ?? '')
    expect(reached.has('/p/src/main/tests/helper.ts')).toBe(false)
    expect(reached.has('/p/src/main/orphan.ts')).toBe(false)
  })
})
