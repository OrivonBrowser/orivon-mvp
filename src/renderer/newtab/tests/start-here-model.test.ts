import { describe, expect, it } from 'vitest'
import { readStartHere, stepText } from '../start-here-model.js'

const view = { app: { name: 'Explore', address: 'ipfs://explore.orivonstack.eth' }, site: 'ipfs://explore.orivonstack.eth', steps: [{ id: 'app', done: false }, { id: 'eth', done: true }], uboOn: true }

describe('readStartHere', () => {
  it('reads the card main sent', () => {
    expect(readStartHere(view)).toEqual(view)
  })

  it('reads nothing from what is not the card', () => {
    for (const bad of [null, 'x', {}, { ...view, steps: [] }, { ...view, steps: [{ id: 'other', done: true }] }, { ...view, app: { name: 'A', address: 'javascript:1' } }, { ...view, site: 'https://x.example' }]) expect(readStartHere(bad)).toBeNull()
  })

  it('shows the uBlock Origin line only for true', () => {
    expect(readStartHere({ ...view, uboOn: 'yes' })?.uboOn).toBe(false)
  })
})

describe('stepText', () => {
  it('names the app the first step opens', () => {
    expect(stepText('app', readStartHere(view)!)).toMatchObject({ title: 'Open an app', action: 'Open Explore', target: 'ipfs://explore.orivonstack.eth' })
  })

  it('explains the shield in the second step and opens the import page from the third', () => {
    const card = readStartHere(view)!
    expect(stepText('eth', card).detail).toBe('The shield in the address bar shows how the name was checked.')
    expect(stepText('import', card).target).toBe('orivon://import')
  })
})
