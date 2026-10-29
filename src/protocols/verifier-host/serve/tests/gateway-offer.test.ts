import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { isDocumentLoad } from '../gateway-offer.js'

const request = (headers: Record<string, string>): IncomingMessage => ({ headers }) as unknown as IncomingMessage

describe('a page load the person started', () => {
  it('is a navigation whose destination is a document', () => {
    expect(isDocumentLoad(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' }))).toBe(true)
  })

  it('is not a file a page asks for, or a frame', () => {
    expect(isDocumentLoad(request({ 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }))).toBe(false)
    expect(isDocumentLoad(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' }))).toBe(false)
    expect(isDocumentLoad(request({}))).toBe(false)
  })

  it('is not a load the browser makes ahead of time, a prefetch or a prerender, which the person has not asked for', () => {
    expect(isDocumentLoad(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch' }))).toBe(false)
    expect(isDocumentLoad(request({ 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-purpose': 'prefetch;prerender' }))).toBe(false)
  })
})
