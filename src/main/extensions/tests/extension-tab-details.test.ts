import { describe, expect, it } from 'vitest'
import { applyOrivonTabDetails, type OrivonTabDetails } from '../extension-tab-details.js'

describe('applyOrivonTabDetails', () => {
  it('always marks the tab unpinned', () => {
    const details: OrivonTabDetails = { pinned: true }
    applyOrivonTabDetails(details, null)
    expect(details.pinned).toBe(false)
  })

  it('overrides favIconUrl with the captured favicon when one exists', () => {
    const details: OrivonTabDetails = { pinned: false, favIconUrl: 'https://example.com/page-declared.ico' }
    applyOrivonTabDetails(details, 'data:image/png;base64,abc123')
    expect(details.favIconUrl).toBe('data:image/png;base64,abc123')
  })

  it('leaves favIconUrl alone when no favicon was captured', () => {
    const details: OrivonTabDetails = { pinned: false, favIconUrl: 'https://example.com/page-declared.ico' }
    applyOrivonTabDetails(details, null)
    expect(details.favIconUrl).toBe('https://example.com/page-declared.ico')
  })

  it('leaves favIconUrl unset when none was ever present and none was captured', () => {
    const details: OrivonTabDetails = { pinned: false }
    applyOrivonTabDetails(details, null)
    expect(details.favIconUrl).toBeUndefined()
  })
})
