import { describe, expect, it } from 'vitest'
import { closeStart, isEthPageUrl, DEFAULT_APP, EMPTY_START, isComplete, markStep, parseStart, startHereView, type StartHereFacts } from '../start-here-state.js'

const facts: StartHereFacts = { isPrivate: false, firstRunApp: null, importAvailable: true, uboOn: true }

describe('startHereView', () => {
  it('offers FreeTube when the profile has no first-run app', () => {
    expect(startHereView(EMPTY_START, facts)?.app).toEqual(DEFAULT_APP)
    expect(DEFAULT_APP.address).toBe('ipfs://freetube.orivonstack.eth')
  })

  it('offers the first-run app when one is stored', () => {
    const app = { name: 'Explore', address: 'ipfs://explore.orivonstack.eth' }
    expect(startHereView(EMPTY_START, { ...facts, firstRunApp: app })?.app).toEqual(app)
  })

  it('shows the import step only when another browser has a profile here', () => {
    expect(startHereView(EMPTY_START, facts)?.steps.map((step) => step.id)).toEqual(['app', 'eth', 'import'])
    expect(startHereView(EMPTY_START, { ...facts, importAvailable: false })?.steps.map((step) => step.id)).toEqual(['app', 'eth'])
  })

  it('ticks the steps that are done', () => {
    const state = markStep(markStep(EMPTY_START, 'eth'), 'import')
    expect(startHereView(state, facts)?.steps).toEqual([{ id: 'app', done: false }, { id: 'eth', done: true }, { id: 'import', done: true }])
  })

  it('carries the uBlock Origin line only while it is on', () => {
    expect(startHereView(EMPTY_START, facts)?.uboOn).toBe(true)
    expect(startHereView(EMPTY_START, { ...facts, uboOn: false })?.uboOn).toBe(false)
  })

  it('is gone in a private session, after Dismiss and once every shown step is done', () => {
    expect(startHereView(EMPTY_START, { ...facts, isPrivate: true })).toBeNull()
    expect(startHereView(closeStart(EMPTY_START), facts)).toBeNull()
    const two = markStep(markStep(EMPTY_START, 'app'), 'eth')
    expect(startHereView(two, facts)).not.toBeNull()
    expect(startHereView(two, { ...facts, importAvailable: false })).toBeNull()
    expect(isComplete(two, { ...facts, importAvailable: false })).toBe(true)
    expect(isComplete(two, facts)).toBe(false)
  })
})

describe('start state', () => {
  it('marks a step once and keeps the order it was done in out of the data', () => {
    expect(markStep(markStep(EMPTY_START, 'app'), 'app').done).toEqual(['app'])
  })

  it('reads only what this version writes', () => {
    expect(parseStart({ done: ['eth', 'bogus', 'eth'], closed: true })).toEqual({ done: ['eth'], closed: true })
    expect(parseStart({ done: 'app', closed: 'yes' })).toEqual(EMPTY_START)
    expect(parseStart(null)).toEqual(EMPTY_START)
  })
})

describe('isEthPageUrl', () => {
  it('takes a .eth name as served, and nothing else', () => {
    expect(isEthPageUrl('https://vitalik.eth/')).toBe(true)
    expect(isEthPageUrl('https://explore.orivonstack.eth/#/search')).toBe(true)
    for (const other of ['https://example.com/', 'https://eth/', 'http://vitalik.eth/', 'https://vitalik.eth:8443/', 'https://vitalik.eth.example/', 'ipfs://vitalik.eth', 'about:blank', '']) expect(isEthPageUrl(other), other).toBe(false)
  })
})
