// test:changed reads src/contracts/ scripts/ai/
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MAX_PURPOSE, NO_README, buildMap, commentPurpose, filterMap, parseArguments, readmePurpose, renderMap, tableRowPurpose
} from '../code-map.mjs'

const fixture = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-code-map-'))
  for (const [path, text] of Object.entries(files)) {
    const full = join(root, ...path.split('/'))
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  return root
}

describe('readmePurpose', () => {
  it('takes the title without its markdown and the path it opens with', () => {
    expect(readmePurpose('# `src/main/`: the **Electron** main process\n\nBody.')).toBe('the Electron main process')
    expect(readmePurpose('# `src/shim/`: `orivon-node-shim`\n')).toBe('orivon-node-shim')
    expect(readmePurpose('# `scripts/` — build and CI guards\n')).toBe('build and CI guards')
    expect(readmePurpose('# `tunnels/`: the [logos](logos.md) in the list\n')).toBe('the logos in the list')
    expect(readmePurpose('# src/loader/ - the app loader\n')).toBe('the app loader')
  })

  it('keeps a title that has no path, and an asterisk inside a code span', () => {
    expect(readmePurpose('# Web3 Score: what it is\n')).toBe('Web3 Score: what it is')
    expect(readmePurpose('# `src/contracts/`: the `orivon.*` entry points\n')).toBe('the orivon.* entry points')
  })

  it('reads the first sentence below a title that is only a path', () => {
    const markdown = '# `scripts/ci/`\n\nHow CI picks the specs to run. Each is a pure function.\n\n| a | b |\n'
    expect(readmePurpose(markdown)).toBe('How CI picks the specs to run.')
    expect(readmePurpose('# `src/x/`\n\n**What lives here.** The thing itself. More.\n')).toBe('The thing itself.')
  })

  it('has no purpose without a heading or a paragraph, and skips a heading inside a code fence', () => {
    expect(readmePurpose('just words\n')).toBeNull()
    expect(readmePurpose('# `src/x/`\n\n| a | b |\n|---|---|\n')).toBeNull()
    expect(readmePurpose('```\n# not a title\n```\n\n# `src/x/`: the real title\n')).toBe('the real title')
  })

  it('cuts a long title at a word, within MAX_PURPOSE', () => {
    const purpose = readmePurpose(`# \`src/x/\`: ${'word '.repeat(60)}`)
    expect(purpose?.length).toBeLessThanOrEqual(MAX_PURPOSE)
    expect(purpose?.endsWith('word...')).toBe(true)
  })
})

describe('commentPurpose', () => {
  it('takes the first sentence of a leading line comment', () => {
    const source = '// The toast: an icon and one line. Main sends the whole view.\nimport x from "y"\n'
    expect(commentPurpose(source)).toBe('The toast: an icon and one line.')
  })

  it('takes the first sentence of a leading block comment', () => {
    expect(commentPurpose('/**\n * Fails the build if a file is too long.\n * Rule 2.\n */\nexport {}\n'))
      .toBe('Fails the build if a file is too long.')
  })

  it('joins a sentence that runs over lines and does not end it at e.g. or a version', () => {
    expect(commentPurpose('// Reads the files, e.g. the\n// README in v1.2 of a folder. Then more.\n'))
      .toBe('Reads the files, e.g. the README in v1.2 of a folder.')
  })

  it('goes past a shebang and tool directives', () => {
    expect(commentPurpose('#!/usr/bin/env node\n// @ts-nocheck\n// test:changed reads src/\n// Does the thing.\n'))
      .toBe('Does the thing.')
  })

  it('has none when the file opens with code or with a licence', () => {
    expect(commentPurpose("import x from 'y'\n// A comment lower down.\n")).toBeNull()
    expect(commentPurpose('// Copyright 2026 Someone. All rights reserved.\n')).toBeNull()
    expect(commentPurpose('/* never closed\n')).toBeNull()
    expect(commentPurpose('')).toBeNull()
  })
})

describe('tableRowPurpose', () => {
  const table = '| Folder | What it proves |\n|---|---|\n| [`app-loading/`](app-loading/) | How an app is found. More. |\n| `tabs/` | The tab strip |\n'

  it('reads the second cell of the row that names the directory, linked or not', () => {
    expect(tableRowPurpose(table, 'app-loading')).toBe('How an app is found.')
    expect(tableRowPurpose(table, 'tabs')).toBe('The tab strip')
  })

  it('has none for a directory no row names, or a row of files', () => {
    expect(tableRowPurpose(table, 'tab')).toBeNull()
    expect(tableRowPurpose('| `tabs.ts` | A file |\n', 'tabs')).toBeNull()
  })
})

describe('buildMap', () => {
  const root = fixture({
    'src/README.md': '# `src/`: the browser\n',
    'src/b/README.md': '# `src/b/`: second\n',
    'src/a/README.md': '# `src/a/`: first\n',
    'src/a/deep/index.ts': '// The deep one.\nexport {}\n',
    'src/a/deep/more/x.ts': 'export {}\n',
    'src/a/tests/t.test.ts': '',
    'src/a/__tests__/t.ts': '',
    'src/a/generated/g.ts': '',
    'src/a/node_modules/m/index.js': '',
    'src/a/.hidden/h.ts': '',
    'src/a/README-only/README.md': '# `src/a/README-only/`: both\n',
    'src/c/c.ts': '// The c file.\n',
    'src/c/other/o.ts': 'export {}\n',
    'src/table/README.md': '# `src/table/`\n\n| Dir | Job |\n|---|---|\n| `row/` | Listed by its parent |\n',
    'src/table/row/r.ts': 'export {}\n',
    'test/README.md': '# `test/`: the suites\n',
    'test/area/e2e-x.test.ts': '',
    'test/area/deeper/e2e-y.test.ts': ''
  })
  const entries = buildMap(root)
  const at = (path: string) => entries.find((entry) => entry.path === path)

  it('lists each directory once, parents first and siblings in name order', () => {
    expect(entries.map((entry) => entry.path)).toEqual([
      'src', 'src/a', 'src/a/README-only', 'src/a/deep', 'src/a/deep/more', 'src/b', 'src/c', 'src/c/other',
      'src/table', 'src/table/row', 'test', 'test/area'
    ])
    expect(entries.map((entry) => entry.depth)).toEqual([0, 1, 2, 2, 3, 1, 1, 2, 1, 2, 0, 1])
  })

  it('never lists unit tests, generated output, packages or dot directories', () => {
    expect(entries.some((entry) => /tests|__tests__|generated|node_modules|hidden/.test(entry.path))).toBe(false)
  })

  it('gives a README first, then the comment of the main file, then the parent README table, then nothing', () => {
    expect(at('src/a')?.purpose).toBe('first')
    expect(at('src/a/deep')?.purpose).toBe('The deep one.')
    expect(at('src/c')?.purpose).toBe('The c file.')
    expect(at('src/table/row')?.purpose).toBe('Listed by its parent')
    expect(at('src/a/deep/more')?.purpose).toBeNull()
    expect(at('src/c/other')?.purpose).toBeNull()
  })

  it('lists the files inside a directory, never its README', () => {
    expect(at('src/c')?.files).toEqual(['c.ts'])
    expect(at('src/a')?.files).toEqual([])
  })

  it('limits the depth, by option and by what each root lists', () => {
    expect(buildMap(root, { depth: 1 }).map((entry) => entry.path)).toEqual(
      ['src', 'src/a', 'src/b', 'src/c', 'src/table', 'test', 'test/area'])
    expect(buildMap(root, { roots: { src: 0, test: Infinity } }).map((entry) => entry.path)).toEqual(
      ['src', 'test', 'test/area', 'test/area/deeper'])
  })

  it('skips a root that is not there', () => {
    expect(buildMap(root, { roots: { vendor: 1, test: 0 } }).map((entry) => entry.path)).toEqual(['test'])
  })
})

describe('filterMap', () => {
  const root = fixture({
    'src/README.md': '# `src/`: the browser\n',
    'src/wallet/README.md': '# `src/wallet/`: the layers over the registry\n',
    'src/wallet/eth/README.md': '# `src/wallet/eth/`: Ethereum, and what a person signs\n',
    'src/wallet/btc/README.md': '# `src/wallet/btc/`: Bitcoin\n',
    'src/wallet/btc/sign-payloads.ts': 'export {}\n',
    'src/main/README.md': '# `src/main/`: the Electron main process\n',
    'src/main/extensions/README.md': '# `src/main/extensions/`: Chrome extensions\n',
    'src/protocols/README.md': '# `src/protocols/`: the ways a site is found\n',
    'src/protocols/ens/README.md': '# `src/protocols/ens/`: the ENS resolver\n',
    'test/README.md': '# `test/`: the end-to-end suites\n',
    'test/tabs/e2e-a.test.ts': '',
    'test/tabs/e2e-b.test.ts': '',
    'test/tabs/e2e-c.test.ts': '',
    'test/sites/notes.ts': ''
  })
  const entries = buildMap(root)
  const paths = (words: string[]) => filterMap(entries, words).map((entry) => entry.path)

  it('keeps everything for no words', () => {
    expect(filterMap(entries, [])).toBe(entries)
    expect(filterMap(entries, [''])).toBe(entries)
  })

  it('keeps the directories whose path or purpose holds every word, with their parents', () => {
    expect(paths(['wallet'])).toEqual(['src', 'src/wallet', 'src/wallet/btc', 'src/wallet/eth'])
    expect(paths(['bitcoin'])).toEqual(['src', 'src/wallet', 'src/wallet/btc'])
    expect(paths(['wallet', 'signs'])).toEqual(['src', 'src/wallet', 'src/wallet/eth'])
  })

  it('matches case-insensitively', () => {
    expect(paths(['WALLET', 'Signs'])).toEqual(paths(['wallet', 'signs']))
  })

  it('matches where a word starts, so ens is not every extensions', () => {
    expect(paths(['ens'])).toEqual(['src', 'src/protocols', 'src/protocols/ens'])
    expect(paths(['protocol'])).toEqual(['src', 'src/protocols', 'src/protocols/ens'])
    expect(paths(['tension'])).toEqual([])
  })

  it('matches a word in a file name, and names the files that made it match', () => {
    const shown = filterMap(entries, ['wallet', 'sign'])
    expect(shown.map((entry) => entry.path)).toEqual(['src', 'src/wallet', 'src/wallet/btc', 'src/wallet/eth'])
    expect(shown.find((entry) => entry.path === 'src/wallet/btc')?.matchedFiles).toEqual(['sign-payloads.ts'])
    expect(shown.find((entry) => entry.path === 'src/wallet/eth')?.matchedFiles).toEqual([])
    expect(shown.find((entry) => entry.path === 'src/wallet')?.matchedFiles).toBeUndefined()
  })

  it('reads e2e as end-to-end as well', () => {
    expect(paths(['e2e'])).toEqual(['test', 'test/tabs'])
    expect(paths(['end-to-end'])).toEqual(['test'])
  })

  it('has nothing for a word nothing holds', () => {
    expect(paths(['wallet', 'zzz'])).toEqual([])
  })
})

describe('renderMap', () => {
  it('indents by depth and says when nothing describes a directory', () => {
    expect(renderMap([
      { path: 'src', depth: 0, purpose: 'the browser', files: [] },
      { path: 'src/a', depth: 1, purpose: null, files: [] }
    ])).toBe(`src/ - the browser\n  src/a/ - ${NO_README}`)
  })

  it('shows two matching files and counts the rest', () => {
    const entry = { path: 'test/tabs', depth: 1, purpose: 'tabs', files: [] }
    expect(renderMap([{ ...entry, matchedFiles: ['a.ts'] }])).toBe('  test/tabs/ - tabs [files: a.ts]')
    expect(renderMap([{ ...entry, matchedFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] }]))
      .toBe('  test/tabs/ - tabs [files: a.ts, b.ts, +2 more]')
    expect(renderMap([{ ...entry, matchedFiles: [] }])).toBe('  test/tabs/ - tabs')
  })
})

describe('plain ASCII', () => {
  it('spells typographic marks plainly and drops accents, so the output stays ASCII', () => {
    expect(readmePurpose('# `src/a/`: caf\u00e9 \u2014 the \u201cone\u201d it\u2019s\u2026\n')).toBe('cafe - the "one" it\'s...')
    expect(commentPurpose('// Caf\u00e9 \u65e5\u672c.\n')).toBe('Cafe ??.')
  })
})

describe('parseArguments', () => {
  it('collects words and the depth', () => {
    expect(parseArguments(['wallet', '--depth', '2', 'signing'])).toEqual({ words: ['wallet', 'signing'], depth: 2, help: false })
    expect(parseArguments(['--depth=0']).depth).toBe(0)
    expect(parseArguments([]).depth).toBe(Infinity)
  })

  it('refuses a depth that is not a whole number and an option it does not know', () => {
    expect(parseArguments(['--depth']).error).toMatch(/whole number/)
    expect(parseArguments(['--depth', 'x']).error).toMatch(/whole number/)
    expect(parseArguments(['--depth=-1']).error).toMatch(/whole number/)
    expect(parseArguments(['--deep']).error).toMatch(/unknown option/)
  })

  it('knows --help', () => {
    expect(parseArguments(['-h']).help).toBe(true)
  })
})

describe('the command', () => {
  const script = join(dirname(fileURLToPath(import.meta.url)), '..', 'code-map.mjs')
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  it('prints the repository as a tree and narrows it by words', () => {
    const lines = run('--depth', '1').trimEnd().split('\n')
    expect(lines[0]).toMatch(/^src\/ - \S/)
    expect(lines).toContainEqual(expect.stringMatching(/^ {2}src\/contracts\/ - \S/))
    expect(lines.every((line) => /^( {2})*[a-z][\w-]*(\/[\w.-]+)*\/ - \S/.test(line))).toBe(true)
    expect(run('contracts').trimEnd().split('\n')).toContainEqual(expect.stringMatching(/^ {2}src\/contracts\/ - \S/))
  })

  it('says so when no directory matches, and exits 2 on a bad option', () => {
    expect(run('zzzzzzzzzz')).toMatch(/^No directory matches "zzzzzzzzzz"/)
    expect(() => run('--depth', 'x')).toThrow()
  })
})
