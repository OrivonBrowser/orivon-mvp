import { describe, expect, it } from 'vitest'
import { LIMITS } from '../../../contracts/index.js'
import { bareFileName, boundedAddress, downloadDetail, popupDetail } from '../embed-events.js'

describe('boundedAddress', () => {
  it('keeps an address at the limit and empties one byte past it', () => {
    const atLimit = 'https://a.example/' + 'x'.repeat(LIMITS.embedEventUrlBytes - 'https://a.example/'.length)
    expect(boundedAddress(atLimit)).toBe(atLimit)
    expect(boundedAddress(atLimit + 'x')).toBe('')
  })

  it('counts UTF-8 bytes, not characters', () => {
    // Half the limit in two-byte characters is under it in characters and over it in bytes.
    const wide = 'é'.repeat(LIMITS.embedEventUrlBytes / 2 + 1)
    expect(wide.length).toBeLessThan(LIMITS.embedEventUrlBytes)
    expect(boundedAddress(wide)).toBe('')
    expect(boundedAddress('é'.repeat(LIMITS.embedEventUrlBytes / 2))).not.toBe('')
  })

  it('passes an address on any scheme through', () => {
    for (const url of ['about:blank', 'foo://x/y', 'blob:http://a.localhost:8080/1-2', 'data:text/plain,hi']) {
      expect(boundedAddress(url)).toBe(url)
    }
  })
})

describe('bareFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['a/b/report.pdf', 'report.pdf'],
    ['a\\b\\report.pdf', 'report.pdf'],
    ['/etc/passwd', 'passwd'],
    ['C:\\Users\\x\\report.pdf', 'report.pdf'],
    ['../../report.pdf', 'report.pdf'],
    ['dir/', ''],
    ['..', ''],
    ['.', ''],
    ['', ''],
    ['.hidden', '.hidden']
  ])('%j becomes %j', (input, expected) => {
    expect(bareFileName(input)).toBe(expected)
  })
})

describe('popupDetail', () => {
  const plain = { url: 'https://a.example/x', frameName: '_blank', disposition: 'foreground-tab', referrer: { url: 'https://b.example/' } }

  it('carries the fields as they came', () => {
    expect(popupDetail(plain)).toEqual({ url: 'https://a.example/x', disposition: 'foreground-tab', frameName: '_blank', referrer: 'https://b.example/', method: 'GET' })
  })

  it('reports a post when the window-open details carry a body, and a get otherwise', () => {
    expect(popupDetail({ ...plain, postBody: { contentType: 'application/x-www-form-urlencoded', data: [] } }).method).toBe('POST')
    expect(popupDetail({ ...plain, postBody: undefined }).method).toBe('GET')
  })

  it('gives an empty referrer when there is none', () => {
    expect(popupDetail({ ...plain, referrer: undefined }).referrer).toBe('')
    expect(popupDetail({ ...plain, referrer: { url: '' } }).referrer).toBe('')
  })

  it('names every disposition Electron can report, and anything else as other', () => {
    for (const disposition of ['default', 'foreground-tab', 'background-tab', 'new-window', 'other'] as const) {
      expect(popupDetail({ ...plain, disposition }).disposition).toBe(disposition)
    }
    expect(popupDetail({ ...plain, disposition: 'save-to-disk' }).disposition).toBe('other')
  })

  it('delivers an over-long address as an empty string and leaves the rest', () => {
    const detail = popupDetail({ ...plain, url: 'https://a.example/' + 'x'.repeat(LIMITS.embedEventUrlBytes) })
    expect(detail.url).toBe('')
    expect(detail.frameName).toBe('_blank')
  })
})

describe('downloadDetail', () => {
  it('takes the last address of the chain, after any redirect', () => {
    const detail = downloadDetail({ urlChain: ['https://a.example/go', 'https://a.example/file.bin'], filename: 'file.bin', mimeType: 'application/octet-stream', totalBytes: 12 })
    expect(detail).toEqual({ url: 'https://a.example/file.bin', filename: 'file.bin', mimeType: 'application/octet-stream', totalBytes: 12 })
  })

  it('strips a directory from the file name', () => {
    expect(downloadDetail({ urlChain: ['https://a.example/f'], filename: '../../x/f.txt', mimeType: '', totalBytes: 0 }).filename).toBe('f.txt')
  })

  it('reports an unknown size as 0, never a negative or non-finite number', () => {
    for (const totalBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY, 0]) {
      expect(downloadDetail({ urlChain: ['https://a.example/f'], filename: 'f', mimeType: '', totalBytes }).totalBytes).toBe(0)
    }
  })

  it('delivers an over-long address as an empty string', () => {
    const url = 'https://a.example/' + 'x'.repeat(LIMITS.embedEventUrlBytes)
    expect(downloadDetail({ urlChain: [url], filename: 'f', mimeType: 'text/plain', totalBytes: 5 })).toEqual({ url: '', filename: 'f', mimeType: 'text/plain', totalBytes: 5 })
  })

  it('gives an empty address for an empty chain', () => {
    expect(downloadDetail({ urlChain: [], filename: 'f', mimeType: '', totalBytes: 0 }).url).toBe('')
  })
})
