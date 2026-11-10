import { describe, expect, it } from 'vitest'
import { forgetShellAnswered, noteMainFrameResponse, takeMainFrameAnswer } from '../shell-answered.js'

// Which main-frame document the shell answered: noted when the response arrives, taken once when that document commits.

const URL_A = 'https://kept.eth/'

describe('the document the shell answered', () => {
  it('is taken once, by the commit of the address it was answered for', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeMainFrameAnswer(page, URL_A)).toBe('shell')
    expect(takeMainFrameAnswer(page, URL_A)).toBe('none')
  })

  it('is never an answer for another page, or for another address', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeMainFrameAnswer({}, URL_A)).toBe('none')
    expect(takeMainFrameAnswer(page, 'https://kept.eth/other.html')).toBe('other')
    noteMainFrameResponse(page, URL_A, true)
    expect(takeMainFrameAnswer(page, 'https://other.eth/')).toBe('other')
  })

  it('reads the address as the document\'s, whatever fragment the commit shows', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeMainFrameAnswer(page, `${URL_A}#top`)).toBe('shell')
  })

  it('holds the last response only: one the network gave replaces one the shell gave', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    noteMainFrameResponse(page, URL_A, false)
    expect(takeMainFrameAnswer(page, URL_A)).toBe('other')
  })

  it('is forgotten when a navigation starts, so a commit that no response came for (a worker) is not taken for the earlier one, and says so', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    forgetShellAnswered(page)
    expect(takeMainFrameAnswer(page, URL_A)).toBe('none')
  })

  it('tells a response the network or the cache gave from none at all', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, false)
    expect(takeMainFrameAnswer(page, URL_A)).toBe('other')
    expect(takeMainFrameAnswer(page, URL_A)).toBe('none')
  })

  it('takes an address it cannot read as no response at all', () => {
    const page = {}
    noteMainFrameResponse(page, 'not an address', true)
    expect(takeMainFrameAnswer(page, 'not an address')).toBe('none')
  })
})
