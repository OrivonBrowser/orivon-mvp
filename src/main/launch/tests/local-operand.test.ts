import { describe, expect, it } from 'vitest'
import { addressesFromOperands, localOperandUrl } from '../local-operand.js'

const present = (...paths: string[]) => (path: string) => paths.includes(path) ? 'file' as const : path === '/work/docs' ? 'directory' as const : undefined

describe('localOperandUrl', () => {
  it('takes a file: URI as it is', () => {
    expect(localOperandUrl('file:///home/u/a%20b.html', '/work', present(), 'linux')).toBe('file:///home/u/a%20b.html')
  })

  it('refuses a file: URI with a host', () => {
    expect(localOperandUrl('file://server/share/a.html', '/work', present(), 'linux')).toBeNull()
  })

  it('resolves an existing relative path against the directory of the start', () => {
    expect(localOperandUrl('notes/a.html', '/work', present('/work/notes/a.html'), 'linux')).toBe('file:///work/notes/a.html')
    expect(localOperandUrl('../x.html', '/work', present('/x.html'), 'linux')).toBe('file:///x.html')
  })

  it('takes an existing absolute path and a directory', () => {
    expect(localOperandUrl('/home/u/a.html', '/work', present('/home/u/a.html'), 'linux')).toBe('file:///home/u/a.html')
    expect(localOperandUrl('docs', '/work', present(), 'linux')).toBe('file:///work/docs')
  })

  it('refuses a path that does not exist', () => {
    expect(localOperandUrl('missing.html', '/work', present(), 'linux')).toBeNull()
  })

  it.each(['https://example.com/', 'mailto:a@b.example', 'javascript:alert(1)', 'data:text/html,x', 'orivon://settings'])('refuses %s, which is no path', (operand) => {
    expect(localOperandUrl(operand, '/work', () => 'file', 'linux')).toBeNull()
  })

  it('takes a Windows drive path', () => {
    expect(localOperandUrl('C:\\Users\\u\\a.html', 'D:\\work', (path) => path === 'C:\\Users\\u\\a.html' ? 'file' : undefined, 'win32')).toBe('file:///C:/Users/u/a.html')
  })
})

describe('addressesFromOperands', () => {
  it('keeps the order of the operands, web addresses and files together, and stops at the limit', () => {
    const operands = ['https://a.example/', 'a.html', 'mailto:x@y.example', 'file:///tmp/b.html', 'https://c.example/']
    const found = addressesFromOperands(operands, '/work', present('/work/a.html'), 'linux', 3)
    expect(found).toEqual(['https://a.example/', 'file:///work/a.html', 'file:///tmp/b.html'])
  })
})
