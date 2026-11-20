import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { noticeOf, packageDirOf, renderNotices } from '../licence-notices-plugin.js'

const ROOT = '/work/orivon'

describe('packageDirOf', () => {
  it('names the folder after the last node_modules, whatever file of the package the module is', () => {
    expect(packageDirOf(`${ROOT}/node_modules/viem/_esm/index.js`, ROOT)).toBe(`${ROOT}/node_modules/viem`)
    expect(packageDirOf(`${ROOT}/node_modules/@noble/hashes/sha3.js`, ROOT)).toBe(`${ROOT}/node_modules/@noble/hashes`)
    expect(packageDirOf(`${ROOT}/node_modules/a/node_modules/b/lib/x.js`, ROOT)).toBe(`${ROOT}/node_modules/a/node_modules/b`)
  })

  it('reads through a query, a plugin prefix and backslashes', () => {
    expect(packageDirOf(`${ROOT}/node_modules/@mozilla/readability/Readability.js?raw`, ROOT)).toBe(`${ROOT}/node_modules/@mozilla/readability`)
    expect(packageDirOf(`\0${ROOT}/node_modules/debug/src/node.js?commonjs-module`, ROOT)).toBe(`${ROOT}/node_modules/debug`)
    expect(packageDirOf('C:\\work\\orivon\\node_modules\\tldts\\dist\\index.js', 'C:\\work\\orivon')).toBe('C:/work/orivon/node_modules/tldts')
  })

  it('names a vendored folder, and nothing for Orivon\'s own code or a made-up id', () => {
    expect(packageDirOf(`${ROOT}/vendor/electron-chrome-extensions/src/browser/index.ts`, ROOT)).toBe(`${ROOT}/vendor/electron-chrome-extensions`)
    expect(packageDirOf(`${ROOT}/src/main/index.ts`, ROOT)).toBeUndefined()
    expect(packageDirOf('\0virtual:privacy-notice', ROOT)).toBeUndefined()
  })
})

describe('noticeOf', () => {
  const folder = (files: Record<string, string>): string => {
    const dir = mkdtempSync(join(tmpdir(), 'orivon-notices-'))
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(dir, name, '..'), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    return dir
  }

  it('collects every licence file at the top of a package, and its declared licence', () => {
    const dir = folder({
      'package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0', license: 'MIT' }),
      LICENSE: 'MIT text\n',
      'NOTICE.txt': 'Notice text',
      'README.md': 'not a licence',
      'lib/LICENSE': 'nested, not collected'
    })
    expect(noticeOf(dir, 'fallback')).toEqual({
      name: 'left-pad',
      version: '1.3.0',
      licence: 'MIT',
      texts: [{ file: 'LICENSE', text: 'MIT text' }, { file: 'NOTICE.txt', text: 'Notice text' }]
    })
  })

  it('lists a package with a declared licence and no file, and skips one with neither', () => {
    expect(noticeOf(folder({ 'package.json': JSON.stringify({ name: 'bare', version: '2.0.0', license: 'ISC' }) }), 'x')).toEqual({ name: 'bare', version: '2.0.0', licence: 'ISC', texts: [] })
    expect(noticeOf(folder({ 'package.json': JSON.stringify({ name: 'none', version: '1.0.0' }) }), 'x')).toBeUndefined()
  })

  it('names a vendored folder by the fallback and keeps each of its licence files', () => {
    const notice = noticeOf(folder({ 'LICENSE.md': 'GPL text', 'LICENSE-GPL': 'full GPL' }), 'vendor/some-code')
    expect(notice?.name).toBe('vendor/some-code')
    expect(notice?.texts.map((entry) => entry.file)).toEqual(['LICENSE-GPL', 'LICENSE.md'])
  })
})

describe('renderNotices', () => {
  it('writes one section per package and version, sorted, with its text', () => {
    const text = renderNotices([
      { name: 'b', version: '1.0.0', licence: 'MIT', texts: [{ file: 'LICENSE', text: 'B text' }] },
      { name: 'a', version: '2.0.0', licence: 'ISC', texts: [{ file: 'LICENSE', text: 'A text' }] },
      { name: 'b', version: '1.0.0', licence: 'MIT', texts: [{ file: 'LICENSE', text: 'B text' }] },
      { name: 'c', version: '3.0.0', licence: 'MIT', texts: [] }
    ])
    expect(text.indexOf('a@2.0.0')).toBeLessThan(text.indexOf('b@1.0.0'))
    expect(text.match(/b@1\.0\.0/g)).toHaveLength(1)
    expect(text).toContain('A text')
    expect(text).toContain('c@3.0.0 (licence: MIT)')
    expect(text).toContain('The package ships no licence file.')
  })

  it('names a vendored folder without a version', () => {
    const text = renderNotices([{ name: 'vendor/some-code', version: '', licence: '', texts: [{ file: 'LICENSE', text: 'Some text' }] }])
    expect(text).toContain('vendor/some-code (vendored in the Orivon repository)')
    expect(text).not.toContain('@')
  })
})
