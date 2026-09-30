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

  it('cuts a long name to 200 characters and keeps its extension', () => {
    const name = safeFileName(`${'a'.repeat(300)}.pdf`)
    expect(name).toHaveLength(200)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(safeFileName('b'.repeat(300))).toHaveLength(200)
  })

  it('does not split a surrogate pair when it cuts', () => {
    const name = safeFileName('😀'.repeat(150))
    expect(name.length).toBeLessThanOrEqual(200)
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

  it('stops looking after a bounded number of tries', () => {
    expect(uniquePath(dir, 'f.txt', () => true)).toBe(join(dir, 'f (10001).txt'))
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
