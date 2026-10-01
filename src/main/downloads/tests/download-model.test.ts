import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isActive, safeFileName, summarise, uniquePath } from '../download-model.js'
import type { DownloadEntry } from '../download-types.js'

describe('safeFileName', () => {
  it('keeps only the last part of a path a page suggested', () => {
    expect(safeFileName('../../x')).toBe('x')
    expect(safeFileName('a/b\\c.txt')).toBe('c.txt')
    expect(safeFileName('/etc/passwd')).toBe('passwd')
  })

  it('prefixes a name Windows reserves', () => {
    expect(safeFileName('con.txt')).toBe('_con.txt')
    expect(safeFileName('NUL')).toBe('_NUL')
    expect(safeFileName('com1.tar.gz')).toBe('_com1.tar.gz')
    expect(safeFileName('console.txt')).toBe('console.txt')
  })

  it('never returns an empty name', () => {
    expect(safeFileName('')).toBe('download')
    expect(safeFileName('  ..  ')).toBe('download')
    expect(safeFileName('///')).toBe('download')
    expect(safeFileName('', 'page')).toBe('page')
  })

  it('cuts a long name to 200 bytes and keeps its extension', () => {
    const name = safeFileName(`${'a'.repeat(300)}.pdf`)
    expect(name).toHaveLength(200)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(safeFileName('b'.repeat(300))).toHaveLength(200)
  })

  it('counts bytes, not characters, so a name of CJK text or emoji fits a file system that allows 255', () => {
    for (const text of ['漢'.repeat(150), '😀'.repeat(150), 'é'.repeat(300)]) {
      for (const suggested of [text, `${text}.pdf`]) {
        const name = safeFileName(suggested)
        expect(Buffer.byteLength(name)).toBeLessThanOrEqual(200)
        expect(Buffer.byteLength(name)).toBeGreaterThan(190)
      }
    }
    expect(safeFileName(`${'漢'.repeat(150)}.pdf`).endsWith('.pdf')).toBe(true)
  })

  it('does not split a surrogate pair when it cuts', () => {
    const name = safeFileName('😀'.repeat(150))
    expect(name).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
  })

  it('strips leading and trailing dots and spaces', () => {
    expect(safeFileName('.hidden')).toBe('hidden')
    expect(safeFileName('report.pdf. ')).toBe('report.pdf')
  })

  it('replaces control and bidirectional override characters and what Windows refuses', () => {
    expect(safeFileName('a\u0000b\u001fc.txt')).toBe('a_b_c.txt')
    expect(safeFileName('cod‮fdp.exe')).toBe('cod_fdp.exe')
    expect(safeFileName('a<b>c:d"e|f?g*h')).toBe('a_b_c_d_e_f_g_h')
  })

  it('replaces C1 controls, the Arabic letter mark, zero-width characters and the byte order mark', () => {
    expect(safeFileName('a\u0080b\u009fc')).toBe('a_b_c')
    expect(safeFileName('a\u061cb')).toBe('a_b')
    expect(safeFileName('a\u200bb\u200cc\u200dd\u200ee\u200ff')).toBe('a_b_c_d_e_f')
    expect(safeFileName('a\u202ab\u202ec\u2066d\u2069e')).toBe('a_b_c_d_e')
    expect(safeFileName('a\ufeffb.txt')).toBe('a_b.txt')
  })

  it('prefixes the console device names and the superscript COM and LPT names as well', () => {
    expect(safeFileName('CONIN$')).toBe('_CONIN$')
    expect(safeFileName('conout$.txt')).toBe('_conout$.txt')
    expect(safeFileName('COM\u00b9')).toBe('_COM\u00b9')
    expect(safeFileName('lpt\u00b3.log')).toBe('_lpt\u00b3.log')
    expect(safeFileName('com0')).toBe('com0')
  })
})

describe('uniquePath', () => {
  const dir = join('/', 'downloads')

  it('uses the plain name when it is free', () => {
    expect(uniquePath(dir, 'file.bin', () => false)).toBe(join(dir, 'file.bin'))
  })

  it('numbers the name before its extension, from 1', () => {
    const taken = new Set([join(dir, 'file.bin'), join(dir, 'file (1).bin')])
    expect(uniquePath(dir, 'file.bin', (path) => taken.has(path))).toBe(join(dir, 'file (2).bin'))
  })

  it('keeps .tar.gz whole', () => {
    const taken = new Set([join(dir, 'a.tar.gz')])
    expect(uniquePath(dir, 'a.tar.gz', (path) => taken.has(path))).toBe(join(dir, 'a (1).tar.gz'))
  })

  it('numbers a name with no extension', () => {
    const taken = new Set([join(dir, 'notes')])
    expect(uniquePath(dir, 'notes', (path) => taken.has(path))).toBe(join(dir, 'notes (1)'))
  })

  it('stops counting after a hundred and uses a random suffix, which is also checked', () => {
    const tried: string[] = []
    const suffixes = ['aaaaaaaa', 'bbbbbbbb']
    const path = uniquePath(dir, 'f.txt', (candidate) => {
      tried.push(candidate)
      return candidate !== join(dir, 'f (bbbbbbbb).txt')
    }, () => suffixes.shift() ?? 'cccccccc')
    expect(path).toBe(join(dir, 'f (bbbbbbbb).txt'))
    expect(tried).toHaveLength(1 + 100 + 2)
    expect(tried).not.toContain(join(dir, 'f (101).txt'))
  })

  it('never returns a name that exists, however many copies there are', () => {
    const real = uniquePath(dir, 'f.txt', (candidate) => !/ \([0-9a-f]{8}\)/u.test(candidate))
    expect(real).toMatch(/f \([0-9a-f]{8}\)\.txt$/u)
  })
})

const entry = (over: Partial<DownloadEntry>): DownloadEntry => ({
  id: 'x', url: 'https://a.example/f', referrer: '', fileName: 'f', savePath: '/d/f', mime: '', total: 0, received: 0,
  state: 'completed', startedAt: 0, danger: false, ...over
})

describe('summarise', () => {
  it('counts what is running and adds up the sizes that are known', () => {
    const summary = summarise([
      entry({ state: 'progressing', total: 100, received: 25 }),
      entry({ id: 'y', state: 'paused', total: 100, received: 75 }),
      entry({ id: 'z', state: 'progressing', total: 0, received: 500 }),
      entry({ id: 'w', state: 'completed', total: 100, received: 100 })
    ])
    expect(summary).toEqual({ active: 3, fraction: 0.5, any: true })
  })

  it('has no fraction when no running download knows its size, and nothing when the list is empty', () => {
    expect(summarise([entry({ state: 'progressing' })])).toEqual({ active: 1, fraction: null, any: true })
    expect(summarise([])).toEqual({ active: 0, fraction: null, any: false })
  })

  it('treats progressing and paused as active', () => {
    expect(isActive({ state: 'paused' })).toBe(true)
    expect(isActive({ state: 'interrupted' })).toBe(false)
  })
})
