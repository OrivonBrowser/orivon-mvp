import { describe, expect, it } from 'vitest'
import { forgetShellAnswered, noteMainFrameResponse, takeShellAnswered } from '../shell-answered.js'

// Which main-frame document the shell answered: noted when the response arrives, taken once when that document commits.

const URL_A = 'https://kept.eth/'

describe('the document the shell answered', () => {
  it('is taken once, by the commit of the address it was answered for', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeShellAnswered(page, URL_A)).toBe(true)
    expect(takeShellAnswered(page, URL_A)).toBe(false)
  })

  it('is never an answer for another page, or for another address', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeShellAnswered({}, URL_A)).toBe(false)
    expect(takeShellAnswered(page, 'https://kept.eth/other.html')).toBe(false)
    expect(takeShellAnswered(page, 'https://other.eth/')).toBe(false)
  })

  it('reads the address as the document\'s, whatever fragment the commit shows', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    expect(takeShellAnswered(page, `${URL_A}#top`)).toBe(true)
  })

  it('holds the last response only: one the network gave replaces one the shell gave', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    noteMainFrameResponse(page, URL_A, false)
    expect(takeShellAnswered(page, URL_A)).toBe(false)
  })

  it('is forgotten when a navigation starts, so a commit that no response came for (a cache, a worker) is not taken for the earlier one', () => {
    const page = {}
    noteMainFrameResponse(page, URL_A, true)
    forgetShellAnswered(page)
    expect(takeShellAnswered(page, URL_A)).toBe(false)
  })

  it('takes an address it cannot read as none', () => {
    const page = {}
    noteMainFrameResponse(page, 'not an address', true)
    expect(takeShellAnswered(page, 'not an address')).toBe(false)
  })
})
