import { describe, expect, it } from 'vitest'
import { CHROME_MODULES } from '../chrome/modules.js'
import { chipShown, chipView } from '../chrome/search-mode.js'

describe('the search mode chip', () => {
  it('says the mode, the engine in use and what a click switches to, with the names main pushed', () => {
    expect(chipView({ searchMode: 'web3', searchWeb3Name: 'Explore', searchWeb2Name: 'DuckDuckGo' })).toEqual({
      text: 'Web3',
      label: 'Searching Web3 with Explore. Click to search Web2 with DuckDuckGo.',
      pressed: true
    })
    expect(chipView({ searchMode: 'web2', searchWeb3Name: 'Explore', searchWeb2Name: 'Brave Search' })).toEqual({
      text: 'Web2',
      label: 'Searching Web2 with Brave Search. Click to search Web3 with Explore.',
      pressed: false
    })
  })

  it('leaves the engine out when the Web2 address is the person\'s own and has no name', () => {
    expect(chipView({ searchMode: 'web2', searchWeb3Name: 'Explore', searchWeb2Name: '' }).label).toBe('Searching Web2. Click to search Web3 with Explore.')
  })

  it('shows while the field or the chip has the keyboard, or the field is empty, and not beside a loaded page\'s address', () => {
    expect(chipShown(true, false, 'https://example.com/')).toBe(true)
    expect(chipShown(false, true, 'https://example.com/')).toBe(true)
    expect(chipShown(false, false, '')).toBe(true)
    expect(chipShown(false, false, 'https://example.com/')).toBe(false)
  })

  it('is a module, placed after the address field it belongs to', () => {
    const names = CHROME_MODULES.map((module) => module.name)
    expect(names.indexOf('search-mode')).toBeGreaterThan(names.indexOf('address-suggest'))
  })
})
