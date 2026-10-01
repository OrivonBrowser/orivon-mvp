import { describe, expect, it } from 'vitest'
import { baseName, downloadName, formatFor, isSavableDocument, safeFileName, screenshotName, withExtension } from '../file-names.js'

describe('safeFileName', () => {
  it('keeps an ordinary title and adds the extension', () => {
    expect(safeFileName('Quarterly report', 'pdf')).toBe('Quarterly report.pdf')
  })

  it('turns path separators and reserved characters into spaces, never into a path', () => {
    expect(safeFileName('../../etc/passwd', 'html')).toBe('etc passwd.html')
    expect(safeFileName('a\\b:c*d?e"f<g>h|i', 'html')).toBe('a b c d e f g h i.html')
  })

  it('drops control characters and leading or trailing dots', () => {
    expect(safeFileName('\u0000\u0007line\nbreak', 'pdf')).toBe('line break.pdf')
    expect(safeFileName('...hidden...', 'pdf')).toBe('hidden.pdf')
  })

  it('falls back to "page" for an empty title and for a name Windows reserves', () => {
    expect(safeFileName('', 'pdf')).toBe('page.pdf')
    expect(safeFileName('   ', 'pdf')).toBe('page.pdf')
    expect(safeFileName('CON', 'pdf')).toBe('page.pdf')
    expect(safeFileName('lpt1', 'pdf')).toBe('page.pdf')
    expect(safeFileName('console', 'pdf')).toBe('console.pdf')
  })

  it('cuts a long title to 120 characters without splitting a character', () => {
    const name = safeFileName('x'.repeat(300), 'pdf')
    expect(name).toBe(`${'x'.repeat(120)}.pdf`)
    expect([...safeFileName('😀'.repeat(200), 'pdf')]).toHaveLength(124)
  })
})

describe('screenshotName', () => {
  it('reads the date and the time to the second, with dots in the time', () => {
    expect(screenshotName(new Date(2026, 0, 2, 3, 4, 5))).toBe('Screenshot 2026-01-02 at 03.04.05.png')
  })
})

describe('formatFor', () => {
  it('reads the format from the extension, whatever its case', () => {
    expect(formatFor('/a/page.mhtml')).toBe('MHTML')
    expect(formatFor('/a/page.MHT')).toBe('MHTML')
    expect(formatFor('/a/page.html')).toBe('HTMLComplete')
    expect(formatFor('/a/page.htm')).toBe('HTMLComplete')
    expect(formatFor('/a/page')).toBe('HTMLComplete')
    expect(formatFor('/a/page.mhtml.txt')).toBe('HTMLComplete')
  })
})

describe('baseName', () => {
  it('takes the last segment in either separator style', () => {
    expect(baseName('/a/b/c.pdf')).toBe('c.pdf')
    expect(baseName('C:\\a\\b\\c.pdf')).toBe('c.pdf')
  })
})

describe('isSavableDocument', () => {
  it('trusts the content type when the page gave one', () => {
    expect(isSavableDocument('https://a.example/x.png', 'text/html')).toBe(true)
    expect(isSavableDocument('https://a.example/', 'application/pdf')).toBe(false)
    expect(isSavableDocument('https://a.example/', 'text/plain; charset=utf-8')).toBe(false)
    expect(isSavableDocument('https://a.example/', 'application/xhtml+xml')).toBe(true)
  })

  it('falls back to the address: a page or no extension is a document, a file is not', () => {
    expect(isSavableDocument('https://a.example/', undefined)).toBe(true)
    expect(isSavableDocument('https://a.example/post/1', undefined)).toBe(true)
    expect(isSavableDocument('https://a.example/index.html?x=1', undefined)).toBe(true)
    expect(isSavableDocument('https://a.example/photo.jpg', undefined)).toBe(false)
    expect(isSavableDocument('https://a.example/doc.PDF', undefined)).toBe(false)
    expect(isSavableDocument('not a url', undefined)).toBe(false)
  })
})

describe('downloadName', () => {
  it('uses the address\'s file name, made safe', () => {
    expect(downloadName('https://a.example/files/My%20Doc.pdf?x=1')).toBe('My Doc.pdf')
    expect(downloadName('https://a.example/')).toBe('page.bin')
    expect(downloadName('nonsense')).toBe('download.bin')
  })
})

describe('downloadName: the extension comes from the page, so it is checked', () => {
  it('keeps a plain extension', () => {
    expect(downloadName('https://a.example/files/report.final.PDF')).toBe('report.final.PDF')
  })

  it('uses bin for an extension that holds a separator, a control character or too many characters', () => {
    expect(downloadName('https://a.example/x.a%2Fb%00c')).toBe('x.bin')
    expect(downloadName('https://a.example/x.a%5Cb')).toBe('x.bin')
    expect(downloadName(`https://a.example/x.${'a'.repeat(17)}`)).toBe('x.bin')
    expect(downloadName(`https://a.example/x.${'a'.repeat(16)}`)).toBe(`x.${'a'.repeat(16)}`)
  })
})

describe('withExtension', () => {
  it('adds the extension to a name with none, and leaves one that has any', () => {
    expect(withExtension('/out/report', 'pdf')).toBe('/out/report.pdf')
    expect(withExtension('/out/report.', 'pdf')).toBe('/out/report.pdf')
    expect(withExtension('/out/report.PDF', 'pdf')).toBe('/out/report.PDF')
    expect(withExtension('/out/archive.v2', 'png')).toBe('/out/archive.v2')
    expect(withExtension('C:\\out\\report', 'png')).toBe('C:\\out\\report.png')
  })
})
