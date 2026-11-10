import { describe, expect, it } from 'vitest'
import { CARRY_PAGE_PATH } from '../../../loader/electron/carry-page.js'
import { holdsRequest } from '../hold-rule.js'

const ORIGIN = 'https://wiki.eth'
const serves = (origin: string): boolean => origin === ORIGIN

describe('which request the carry holds', () => {
  it('holds a main-frame page of a served origin', () => {
    expect(holdsRequest({ url: `${ORIGIN}/index.html`, resourceType: 'mainFrame' }, serves)).toBe(true)
  })

  it('lets every other kind of request through, so the shell\'s own reads and the page\'s files never wait', () => {
    for (const resourceType of ['xhr', 'script', 'subFrame', 'image', 'other', 'webSocket']) {
      expect(holdsRequest({ url: `${ORIGIN}/app.js`, resourceType }, serves)).toBe(false)
    }
  })

  it('lets the empty document through, since the carry itself loads it', () => {
    expect(holdsRequest({ url: `${ORIGIN}${CARRY_PAGE_PATH}`, resourceType: 'mainFrame' }, serves)).toBe(false)
  })

  it('does not hold a page of an origin the shell does not serve, or an address that is no origin', () => {
    expect(holdsRequest({ url: 'https://example.com/', resourceType: 'mainFrame' }, serves)).toBe(false)
    expect(holdsRequest({ url: 'not a url', resourceType: 'mainFrame' }, serves)).toBe(false)
  })
})
