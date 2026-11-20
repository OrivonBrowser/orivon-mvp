import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { embeddedPackages, noticeOf, packageDirOf, renderNotices } from '../licence-notices-plugin.js'

// test:changed reads src/shim/worker/ package.json

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

  it('skips a package with neither a licence file nor a declared licence', () => {
    expect(noticeOf(folder({ 'package.json': JSON.stringify({ name: 'none', version: '1.0.0' }) }), 'x')).toBeUndefined()
  })

  it('gives a package with a declared licence and no file the standard text, with its author as the copyright holder', () => {
    const notice = noticeOf(folder({ 'package.json': JSON.stringify({ name: 'bare', version: '2.0.0', license: 'ISC', author: 'Ada Lovelace <ada@example.org> (https://example.org)' }) }), 'x')
    expect(notice).toMatchObject({ name: 'bare', version: '2.0.0', licence: 'ISC', generated: true })
    expect(notice?.texts).toHaveLength(1)
    expect(notice?.texts[0]?.text).toContain('Copyright (c) Ada Lovelace\n')
    expect(notice?.texts[0]?.text).toContain('Permission to use, copy, modify, and/or distribute this software')
  })

  it('names the project its repository field gives when the package has no author', () => {
    const repository = { type: 'git', url: 'git+https://github.com/someone/it-last.git' }
    const notice = noticeOf(folder({ 'package.json': JSON.stringify({ name: 'it-last', version: '3.0.11', license: 'Apache-2.0 OR MIT', author: '', repository }) }), 'x')
    expect(notice?.texts.map((entry) => entry.file)).toEqual(['MIT'])
    expect(notice?.texts[0]?.text).toContain('Copyright (c) the contributors to it-last (https://github.com/someone/it-last)')
    expect(noticeOf(folder({ 'package.json': JSON.stringify({ name: 'lone', version: '1.0.0', license: 'MIT' }) }), 'x')?.texts[0]?.text).toContain('Copyright (c) the authors of lone')
  })

  it('fails for a licence it holds no text for when the package ships no file, so the notices never hold a package without its text', () => {
    expect(() => noticeOf(folder({ 'package.json': JSON.stringify({ name: 'apache-only', version: '1.0.0', license: 'Apache-2.0' }) }), 'x')).toThrow(/apache-only declares the licence "Apache-2\.0" and ships no licence file/)
    expect(() => noticeOf(folder({ 'package.json': JSON.stringify({ name: 'with-exception', version: '1.0.0', license: 'GPL-2.0-only WITH Classpath-exception-2.0' }) }), 'x')).toThrow(/with-exception/)
    expect(() => noticeOf(folder({ 'package.json': JSON.stringify({ name: 'old-style', version: '1.0.0', license: { type: 'MIT' } }) }), 'x')).toThrow(/old-style/)
  })

  it('names a vendored folder by the fallback and keeps each of its licence files', () => {
    const notice = noticeOf(folder({ 'LICENSE.md': 'GPL text', 'LICENSE-GPL': 'full GPL' }), 'vendor/some-code')
    expect(notice?.name).toBe('vendor/some-code')
    expect(notice?.texts.map((entry) => entry.file)).toEqual(['LICENSE-GPL', 'LICENSE.md'])
  })
})

describe('embeddedPackages', () => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-embedded-'))
  writeFileSync(join(root, 'runtime.generated.json'), JSON.stringify({ source: 'x', packages: ['node_modules/pako', 'node_modules/@emnapi/core'] }))
  writeFileSync(join(root, 'other.json'), JSON.stringify({ packages: ['node_modules/not-listed'] }))

  it('names the package folders a prebuilt bundle holds, from the root', () => {
    const slashed = root.replace(/\\/g, '/')
    expect(embeddedPackages(join(root, 'runtime.generated.json'), root)).toEqual([`${slashed}/node_modules/pako`, `${slashed}/node_modules/@emnapi/core`])
  })

  it('reads no other file', () => {
    expect(embeddedPackages(join(root, 'other.json'), root)).toEqual([])
    expect(embeddedPackages(join(root, 'missing.ts'), root)).toEqual([])
  })

  it('gives every package inside the shim\'s Worker runtime a notice with its text, elliptic and its tree included', () => {
    const repository = fileURLToPath(new URL('../../', import.meta.url))
    const dirs = embeddedPackages(join(repository, 'src/shim/worker/runtime.generated.json'), repository)
    const notices = dirs.map((dir) => noticeOf(dir, dir))
    expect(notices.every((notice) => notice !== undefined && notice.texts.length > 0), 'a package of the runtime has no notice').toBe(true)
    const text = renderNotices(notices.flatMap((notice) => notice === undefined ? [] : [notice]))
    for (const name of ['elliptic', 'bn.js', 'browserify-sign', 'sha.js', 'ripemd160', 'pako', 'browserify-zlib', '@emnapi/core', '@emnapi/runtime', 'os-browserify', 'events']) {
      expect(text.split('\n').some((line) => line.startsWith(`${name}@`)), `${name}@ has a section`).toBe(true)
    }
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

  it('says a text is the standard one when the package shipped none', () => {
    const text = renderNotices([{ name: 'bare', version: '2.0.0', licence: 'MIT', texts: [{ file: 'MIT', text: 'Copyright (c) Ada' }], generated: true }])
    expect(text).toContain('The package ships no licence file. The standard MIT text follows')
    expect(text).toContain('Copyright (c) Ada')
  })

  it('names a vendored folder without a version', () => {
    const text = renderNotices([{ name: 'vendor/some-code', version: '', licence: '', texts: [{ file: 'LICENSE', text: 'Some text' }] }])
    expect(text).toContain('vendor/some-code (vendored in the Orivon repository)')
    expect(text).not.toContain('@')
  })
})
