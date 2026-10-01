import { describe, expect, it } from 'vitest'
import { applyOrivonTabDetails, type OrivonTabDetails } from '../extension-tab-details.js'

describe('applyOrivonTabDetails', () => {
  it('marks the tab pinned as the record says, whatever the library guessed', () => {
    const details: OrivonTabDetails = { pinned: true }
    applyOrivonTabDetails(details, null, false)
    expect(details.pinned).toBe(false)
    applyOrivonTabDetails(details, null, true)
    expect(details.pinned).toBe(true)
  })

  it('overrides favIconUrl with the captured favicon when one exists', () => {
    const details: OrivonTabDetails = { pinned: false, favIconUrl: 'https://example.com/page-declared.ico' }
    applyOrivonTabDetails(details, 'data:image/png;base64,abc123', false)
    expect(details.favIconUrl).toBe('data:image/png;base64,abc123')
  })

  it('leaves favIconUrl alone when no favicon was captured', () => {
    const details: OrivonTabDetails = { pinned: false, favIconUrl: 'https://example.com/page-declared.ico' }
    applyOrivonTabDetails(details, null, false)
    expect(details.favIconUrl).toBe('https://example.com/page-declared.ico')
  })

  it('leaves favIconUrl unset when none was ever present and none was captured', () => {
    const details: OrivonTabDetails = { pinned: false }
    applyOrivonTabDetails(details, null, false)
    expect(details.favIconUrl).toBeUndefined()
  })

  it('reports a sleeping tab as discarded, with the address, title and icon it will wake to', () => {
    const details: OrivonTabDetails = { pinned: false, url: '', title: '' }
    applyOrivonTabDetails(details, 'data:image/png;base64,old', false, { url: 'https://a.example/', title: 'A', favicon: 'data:image/png;base64,kept' })
    expect(details).toMatchObject({ discarded: true, url: 'https://a.example/', title: 'A', favIconUrl: 'data:image/png;base64,kept' })
  })

  it('keeps the captured icon for a sleeping tab that kept none, and leaves an awake tab\'s details alone', () => {
    const sleeping: OrivonTabDetails = { pinned: false }
    applyOrivonTabDetails(sleeping, 'data:image/png;base64,old', false, { url: 'https://a.example/', title: 'A', favicon: null })
    expect(sleeping.favIconUrl).toBe('data:image/png;base64,old')
    const awake: OrivonTabDetails = { pinned: false, url: 'https://live.example/' }
    applyOrivonTabDetails(awake, null, false, null)
    expect(awake).toEqual({ pinned: false, url: 'https://live.example/' })
  })
})
