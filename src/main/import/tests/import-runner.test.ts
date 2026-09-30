import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nodeImportFs } from '../import-fs.js'
import { runHtmlImport, runImport } from '../import-runner.js'
import type { ImportDeps } from '../import-runner.js'
import type { ImportSource } from '../import-types.js'
import { makeChromeHistory, makeFirefoxPlaces } from './databases.js'
import { TreeSink } from './tree-sink.js'

let root = ''
let temp = ''
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-runner-'))
  temp = await mkdtemp(join(tmpdir(), 'orivon-runner-temp-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(temp, { recursive: true, force: true })
})

const NOW = Date.UTC(2026, 8, 30)
const BOOKMARKS = JSON.stringify({ roots: {
  bookmark_bar: { type: 'folder', name: 'Bookmarks bar', children: [{ type: 'url', name: 'A', url: 'https://a.test/' }, { type: 'url', name: 'Bad', url: 'javascript:alert(1)' }] },
  other: { type: 'folder', name: 'Other', children: [{ type: 'url', name: 'C', url: 'https://c.test/' }] }
} })

async function chromeProfile (name = 'Default'): Promise<ImportSource> {
  const dir = join(root, name)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'Bookmarks'), BOOKMARKS)
  makeChromeHistory(join(dir, 'History'), [
    { url: 'https://a.test/', title: 'A', visits: 2, at: NOW - 1000 },
    { url: 'https://c.test/', title: 'C', visits: 1, at: NOW - 2000 }
  ], { wal: false }).close()
  return { browser: 'chrome', family: 'chromium', profile: 'Person 1', dir }
}

function depsWith (overrides: Partial<ImportDeps> = {}): { deps: ImportDeps, sink: TreeSink, pages: ReturnType<typeof vi.fn>, phases: string[] } {
  const sink = new TreeSink()
  const pages = vi.fn((rows: readonly unknown[]) => rows.length)
  const phases: string[] = []
  return { sink, pages, phases, deps: { fs: nodeImportFs, bookmarks: sink, history: { importPages: pages }, now: () => NOW, retentionDays: () => null, progress: (phase) => { phases.push(phase) }, tempDir: temp, ...overrides } }
}

describe('runImport, Chromium family', () => {
  it('imports bookmarks and history, reports the phases in order, and counts what the store refused as skipped', async () => {
    const { deps, sink, pages, phases } = depsWith()
    const result = await runImport(await chromeProfile(), { bookmarks: true, history: true }, deps)
    expect(result).toEqual({ bookmarks: 2, pages: 2, skipped: 1, known: 0, target: 'bar' })
    expect(sink.titles('bar')).toEqual(['A'])
    expect(sink.titles('other')).toEqual(['C'])
    expect(pages).toHaveBeenCalledTimes(1)
    expect(phases).toEqual(['bookmarks', 'history'])
  })

  it('imports only what was asked for', async () => {
    const one = depsWith()
    expect(await runImport(await chromeProfile(), { bookmarks: true, history: false }, one.deps)).toMatchObject({ bookmarks: 2, pages: 0 })
    expect(one.pages).not.toHaveBeenCalled()
    const two = depsWith()
    expect(await runImport(await chromeProfile('Profile 1'), { bookmarks: false, history: true }, two.deps)).toMatchObject({ bookmarks: 0, pages: 2 })
    expect(two.sink.tree.nodes.size).toBe(3)
  })

  it('reads history within the retention window and at most 20,000 pages', async () => {
    const source = await chromeProfile()
    const seen: unknown[] = []
    const { deps } = depsWith({ retentionDays: () => 1, history: { importPages: (rows) => { seen.push(...rows); return rows.length } } })
    await runImport(source, { bookmarks: false, history: true }, deps)
    expect(seen).toHaveLength(2)
    const old = depsWith({ now: () => NOW + 3 * 86_400_000, retentionDays: () => 1 })
    expect(await runImport(source, { bookmarks: false, history: true }, old.deps)).toMatchObject({ pages: 0 })
  })

  it('does not import twice: the second run adds no bookmark', async () => {
    const { deps, sink } = depsWith()
    const source = await chromeProfile()
    await runImport(source, { bookmarks: true, history: false }, deps)
    const before = sink.tree.nodes.size
    const again = await runImport(source, { bookmarks: true, history: false }, deps)
    expect(again).toMatchObject({ bookmarks: 0, known: 2 })
    expect(sink.tree.nodes.size).toBe(before)
  })

  it('reports locked, with the bookmarks that were imported, when the history cannot be copied', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const source = await chromeProfile()
    const { chmod } = await import('node:fs/promises')
    await chmod(join(source.dir, 'History'), 0o000)
    try {
      const { deps, sink } = depsWith()
      expect(await runImport(source, { bookmarks: true, history: true }, deps)).toMatchObject({ bookmarks: 2, pages: 0, error: 'locked' })
      expect(sink.titles('bar')).toEqual(['A'])
    } finally {
      await chmod(join(source.dir, 'History'), 0o600)
    }
  })

  it('reports unreadable for a Bookmarks file that is not JSON, and imports nothing', async () => {
    const source = await chromeProfile()
    await writeFile(join(source.dir, 'Bookmarks'), '{not json')
    const { deps, sink, pages } = depsWith()
    expect(await runImport(source, { bookmarks: true, history: true }, deps)).toMatchObject({ bookmarks: 0, pages: 0, error: 'unreadable' })
    expect(sink.tree.nodes.size).toBe(3)
    expect(pages).not.toHaveBeenCalled()
  })

  it('treats a profile with no Bookmarks file as having no bookmarks', async () => {
    const source = await chromeProfile()
    await rm(join(source.dir, 'Bookmarks'))
    const { deps } = depsWith()
    expect(await runImport(source, { bookmarks: true, history: true }, deps)).toMatchObject({ bookmarks: 0, pages: 2 })
  })

  it('reports unreadable for a History file that is not a database', async () => {
    const source = await chromeProfile()
    await writeFile(join(source.dir, 'History'), 'not a database '.repeat(200))
    const { deps } = depsWith()
    expect(await runImport(source, { bookmarks: true, history: true }, deps)).toMatchObject({ bookmarks: 2, error: 'unreadable' })
  })

  it('leaves the source files untouched', async () => {
    const source = await chromeProfile()
    const { readFile } = await import('node:fs/promises')
    const before = await readFile(join(source.dir, 'History'))
    await runImport(source, { bookmarks: true, history: true }, depsWith().deps)
    expect((await readFile(join(source.dir, 'History'))).equals(before)).toBe(true)
  })
})

describe('runImport, Firefox', () => {
  it('reads bookmarks and history from places.sqlite', async () => {
    const dir = join(root, 'ff')
    await mkdir(dir)
    makeFirefoxPlaces(join(dir, 'places.sqlite'), [{ url: 'https://h.test/', title: 'H', visits: 3, at: NOW - 500 }], [
      { id: 1, type: 2, parent: 0, position: 0, title: '', guid: 'root________' },
      { id: 3, type: 2, parent: 1, position: 0, title: 'Toolbar', guid: 'toolbar_____' },
      { id: 4, type: 1, parent: 3, position: 0, title: 'Fox', guid: 'g4', url: 'https://fox.test/' }
    ]).close()
    const { deps, sink } = depsWith()
    const result = await runImport({ browser: 'firefox', family: 'firefox', profile: 'default', dir }, { bookmarks: true, history: true }, deps)
    expect(result).toMatchObject({ bookmarks: 1, pages: 1, target: 'bar' })
    expect(sink.titles('bar')).toEqual(['Fox'])
  })
})

describe('runHtmlImport', () => {
  const FILE = '<!DOCTYPE NETSCAPE-Bookmark-file-1><DL><p><DT><A HREF="https://a.test/">A</A><DT><A HREF="javascript:alert(1)">bad</A></DL>'

  it('imports a bookmarks file and counts a page the store refuses as skipped', () => {
    const { deps, sink } = depsWith()
    expect(runHtmlImport(FILE, deps)).toEqual({ bookmarks: 1, pages: 0, skipped: 1, known: 0, target: 'bar' })
    expect(sink.titles('other')).toEqual(['A'])
  })

  it('reports format for a file that is not a bookmarks file', () => {
    expect(runHtmlImport('<html><p>hi</p></html>', depsWith().deps)).toMatchObject({ bookmarks: 0, error: 'format' })
  })
})
