import { describe, expect, it } from 'vitest'
import { appKey, EMPTY_STATE, giveNewcomerPin, hideTile, parseState, serializeState, showHidden, unpinTile } from '../featured-state.js'

describe('appKey', () => {
  it('takes an id as it is and the label of an Orivon address as its id', () => {
    expect(appKey('Explore')).toBe('explore')
    expect(appKey('ipfs://webtorrent.orivonstack.eth')).toBe('webtorrent')
    expect(appKey('ipfs://webtorrent.orivonstack.eth/')).toBe('webtorrent')
  })

  it('keeps another ipfs or https address whole and refuses everything else', () => {
    expect(appKey('https://app.example')).toBe('https://app.example/')
    expect(appKey('ipfs://foo.example')).toBe('ipfs://foo.example')
    expect(appKey('javascript:alert(1)')).toBeNull()
    expect(appKey('file:///etc/passwd')).toBeNull()
    expect(appKey('not an app')).toBeNull()
    expect(appKey(`https://a.example/${'x'.repeat(3000)}`)).toBeNull()
  })
})

describe('the newcomer pin lifecycle', () => {
  it('is given once, and shows as the pin', () => {
    const state = giveNewcomerPin(EMPTY_STATE, 'ipfs://asgardex.orivonstack.eth')
    expect(state).toMatchObject({ newcomerPin: 'asgardex', given: true })
  })

  it('keeps the name it was given for a tile outside the shipped set, and drops it with the pin', () => {
    const state = giveNewcomerPin(EMPTY_STATE, 'ipfs://freetube.orivonstack.eth', 'FreeTube')
    expect(state).toMatchObject({ newcomerPin: 'freetube', newcomerName: 'FreeTube' })
    expect(unpinTile(state, 'freetube').newcomerName).toBeNull()
    expect(giveNewcomerPin(EMPTY_STATE, 'freetube', 'x'.repeat(41)).newcomerName).toBeNull()
    expect(giveNewcomerPin(EMPTY_STATE, 'freetube', '\u0007  ').newcomerName).toBeNull()
  })

  it('is never given a second time while it is kept', () => {
    const state = giveNewcomerPin(EMPTY_STATE, 'asgardex')
    expect(giveNewcomerPin(state, 'webtorrent')).toBe(state)
  })

  it('is removed by unpinning it, and the setter does not put it back', () => {
    const removed = unpinTile(giveNewcomerPin(EMPTY_STATE, 'asgardex'), 'asgardex')
    expect(removed.newcomerPin).toBeNull()
    expect(removed.unpinned).toEqual(['asgardex'])
    expect(giveNewcomerPin(removed, 'asgardex').newcomerPin).toBeNull()
    expect(giveNewcomerPin(removed, 'webtorrent').newcomerPin).toBeNull()
  })

  it('is removed by hiding it, and showing the hidden tiles does not bring the pin back', () => {
    const hidden = hideTile(giveNewcomerPin(EMPTY_STATE, 'asgardex'), 'asgardex')
    expect(hidden).toMatchObject({ newcomerPin: null, hidden: ['asgardex'] })
    const shown = showHidden(hidden)
    expect(shown.hidden).toEqual([])
    expect(giveNewcomerPin(shown, 'asgardex').newcomerPin).toBeNull()
  })

  it('is untouched by hiding or unpinning another tile', () => {
    const state = hideTile(unpinTile(giveNewcomerPin(EMPTY_STATE, 'asgardex'), 'explore'), 'thelounge')
    expect(state.newcomerPin).toBe('asgardex')
  })

  it('ignores text that is no app', () => {
    expect(giveNewcomerPin(EMPTY_STATE, 'javascript:1')).toBe(EMPTY_STATE)
  })
})

describe('hiding and unpinning', () => {
  it('lists a tile once however often it is hidden, and shows nothing to restore when nothing is hidden', () => {
    const state = hideTile(hideTile(EMPTY_STATE, 'explore'), 'explore')
    expect(state.hidden).toEqual(['explore'])
    expect(showHidden(EMPTY_STATE)).toBe(EMPTY_STATE)
  })

  it('brings every hidden tile back', () => {
    expect(showHidden(hideTile(hideTile(EMPTY_STATE, 'explore'), 'thelounge')).hidden).toEqual([])
  })
})

describe('the file', () => {
  it('round-trips', () => {
    const state = hideTile(unpinTile(giveNewcomerPin(EMPTY_STATE, 'asgardex'), 'explore'), 'thelounge')
    expect(parseState(JSON.parse(serializeState(state)))).toEqual(state)
  })

  it('keeps "given" for a removed pin', () => {
    const state = unpinTile(giveNewcomerPin(EMPTY_STATE, 'asgardex'), 'asgardex')
    expect(parseState(JSON.parse(serializeState(state))).given).toBe(true)
  })

  it('falls back to none for anything it did not write, and drops entries that are no key', () => {
    expect(parseState(null)).toEqual(EMPTY_STATE)
    expect(parseState({ version: 2, hidden: ['explore'] })).toEqual(EMPTY_STATE)
    expect(parseState({ version: 1, newcomerPin: 'javascript:1', hidden: ['explore', 7, 'a b', 'EXPLORE'], unpinned: 'x' }))
      .toEqual({ newcomerPin: null, newcomerName: null, given: false, unpinned: [], hidden: ['explore'], start: { done: [], closed: false } })
  })
})
