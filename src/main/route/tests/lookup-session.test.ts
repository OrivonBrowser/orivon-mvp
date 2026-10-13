import type { Session } from 'electron'
import { describe, expect, it } from 'vitest'
import { lookupSessionFor, setLookupSessionSource } from '../lookup-session.js'

describe('the session for lookups about a routed app', () => {
  it('is none until main supplies one, and then follows it lookup by lookup', async () => {
    expect(await lookupSessionFor('https://one.example')).toBeUndefined()

    const routed = { fetch: async () => new Response('x') } as unknown as Session
    let on = false
    setLookupSessionSource(async (origin) => origin === 'https://one.example' && on ? routed : undefined)

    expect(await lookupSessionFor('https://one.example')).toBeUndefined()
    on = true
    expect(await lookupSessionFor('https://one.example')).toBe(routed)
    expect(await lookupSessionFor('https://two.example')).toBeUndefined()
  })

  it('passes on a rejection, so a routed app whose route is broken makes no lookup at all', async () => {
    setLookupSessionSource(async () => { throw new Error('no route') })
    await expect(lookupSessionFor('https://one.example')).rejects.toThrow('no route')
  })
})
