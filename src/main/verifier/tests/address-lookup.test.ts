// Main's answer when the verifier host asks for the addresses of a name as the name relay finds them.

import { describe, expect, it, vi } from 'vitest'
import { MAX_ANSWERED_ADDRESSES } from '../../../protocols/verifier-host/protocol.js'
import { RelayRefusal } from '../../route/name-relay/relay-failures.js'
import { answerAddressLookup } from '../address-lookup.js'

describe('answerAddressLookup', () => {
  it('says there is no relay while none runs, and looks nothing up', async () => {
    expect(await answerAddressLookup(undefined, 4, 'gateway.example')).toEqual({ type: 'address-answer', id: 4, kind: 'none' })
  })

  it('asks the relay about the https address of the name, and answers with every address it found', async () => {
    const lookup = vi.fn(async () => ['93.184.216.40', '2606:2800::1'])
    expect(await answerAddressLookup(lookup, 5, 'gateway.example')).toEqual({ type: 'address-answer', id: 5, kind: 'addresses', addresses: ['93.184.216.40', '2606:2800::1'] })
    expect(lookup).toHaveBeenCalledExactlyOnceWith('gateway.example', 'https://gateway.example/')
  })

  it('refuses when the relay could not look the name up, with an answer that says nothing of why', async () => {
    const answer = await answerAddressLookup(async () => { throw new RelayRefusal('not-found') }, 6, 'gateway.example')
    expect(answer).toEqual({ type: 'address-answer', id: 6, kind: 'refused' })
    expect(JSON.stringify(answer)).not.toContain('not-found')
  })

  it('refuses a name with no address and a name with more than the host accepts, never cutting the list', async () => {
    expect(await answerAddressLookup(async () => [], 7, 'a.example')).toMatchObject({ kind: 'refused' })
    const many = Array.from({ length: MAX_ANSWERED_ADDRESSES + 1 }, (_, index) => `93.184.216.${String(index)}`)
    expect(await answerAddressLookup(async () => many, 8, 'b.example')).toMatchObject({ kind: 'refused' })
    const exact = many.slice(0, MAX_ANSWERED_ADDRESSES)
    expect(await answerAddressLookup(async () => exact, 9, 'c.example')).toMatchObject({ kind: 'addresses', addresses: exact })
  })
})
