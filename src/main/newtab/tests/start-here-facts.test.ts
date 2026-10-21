import { describe, expect, it, vi } from 'vitest'
import { startHereFacts, UBLOCK_ORIGIN_ID } from '../start-here-facts.js'

const sources = { isPrivate: false, firstRunApp: () => null, otherBrowserFound: async () => true, extensionOn: (id: string) => id === UBLOCK_ORIGIN_ID }

describe('startHereFacts', () => {
  it('reads each part from its source', async () => {
    const app = { name: 'Explore', address: 'ipfs://explore.orivonstack.eth' }
    expect(await startHereFacts({ ...sources, firstRunApp: () => app })()).toEqual({ isPrivate: false, firstRunApp: app, importAvailable: true, uboOn: true })
  })

  it('asks for other browsers once, and reads a failure as none', async () => {
    const look = vi.fn(async () => { throw new Error('no home') })
    const facts = startHereFacts({ ...sources, otherBrowserFound: look })
    expect((await facts()).importAvailable).toBe(false)
    await facts()
    expect(look).toHaveBeenCalledTimes(1)
  })

  it('reads nothing in a private session', async () => {
    const look = vi.fn(async () => true)
    expect(await startHereFacts({ ...sources, isPrivate: true, otherBrowserFound: look })()).toEqual({ isPrivate: true, firstRunApp: null, importAvailable: false, uboOn: false })
    expect(look).not.toHaveBeenCalled()
  })

  it('has the line absent when uBlock Origin is not on', async () => {
    expect((await startHereFacts({ ...sources, extensionOn: () => false })()).uboOn).toBe(false)
  })
})
