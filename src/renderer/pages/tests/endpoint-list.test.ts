import { describe, expect, it } from 'vitest'
import { addEndpoint, joinEndpoints, PROBLEM_SAVE, removeEndpoint, shownEndpoint, splitEndpoints } from '../settings/controls/endpoint-list-model.js'

const KEY = 'FAKE-KEY-0123456789abcdef'
const INFURA = `https://mainnet.infura.io/v3/${KEY}`

describe('the list as text', () => {
  it('reads one address a line, skipping blanks and trimming', () => {
    expect(splitEndpoints(`${INFURA}\n\n  http://127.0.0.1:8545  \n`)).toEqual([INFURA, 'http://127.0.0.1:8545'])
    expect(splitEndpoints('')).toEqual([])
    expect(splitEndpoints(undefined)).toEqual([])
  })

  it('writes it back the same way', () => {
    expect(joinEndpoints([INFURA, 'http://127.0.0.1:8545'])).toBe(`${INFURA}\nhttp://127.0.0.1:8545`)
    expect(joinEndpoints([])).toBe('')
  })
})

describe('shownEndpoint', () => {
  it('hides the key, whatever the address is', () => {
    expect(shownEndpoint(INFURA)).toBe('https://mainnet.infura.io/••••')
    expect(shownEndpoint(`http://127.0.0.1:8545/${KEY}`)).toBe('http://127.0.0.1:8545/••••')
    expect(shownEndpoint('http://192.168.1.20:8545')).toBe('http://192.168.1.20:8545')
  })
})

describe('addEndpoint', () => {
  it('appends a good address, after those listed', () => {
    expect(addEndpoint([INFURA], '  http://127.0.0.1:8545  ', 'execution', 4)).toEqual({ kind: 'added', endpoints: [INFURA, 'http://127.0.0.1:8545'] })
  })

  it('says why an address is refused, in words that hold none of it', () => {
    const outcome = addEndpoint([], `http://rpc.example.com/${KEY}`, 'execution', 4)
    expect(outcome).toMatchObject({ kind: 'invalid' })
    expect(JSON.stringify(outcome)).not.toContain(KEY)
    expect(outcome.kind === 'invalid' && outcome.problem).toMatch(/https/)
  })

  it('says nothing and changes nothing for an address already listed, however it is spelled, even when the list is full', () => {
    expect(addEndpoint([INFURA], INFURA, 'execution', 4)).toEqual({ kind: 'duplicate' })
    expect(addEndpoint(['https://RPC.example.com/x'], 'https://rpc.example.com/x', 'execution', 1)).toEqual({ kind: 'duplicate' })
  })

  it('refuses one more than the list holds', () => {
    expect(addEndpoint(['https://a.example.com', 'https://b.example.com', 'https://c.example.com', 'https://d.example.com'], 'https://e.example.com', 'execution', 4)).toEqual({ kind: 'full' })
    expect(addEndpoint(['https://a.example.com'], 'https://b.example.com', 'beacon', 1)).toEqual({ kind: 'full' })
  })

  it('refuses a ? part in a beacon server\'s address, which an execution server may keep', () => {
    expect(addEndpoint([], 'https://beacon.example.com/?k=1', 'beacon', 1)).toMatchObject({ kind: 'invalid' })
    expect(addEndpoint([], 'https://rpc.example.com/?k=1', 'execution', 4)).toMatchObject({ kind: 'added' })
  })
})

describe('removeEndpoint', () => {
  it('takes out the one at the position', () => {
    expect(removeEndpoint(['a', 'b', 'c'], 1)).toEqual(['a', 'c'])
  })
})

describe('the words when a save fails', () => {
  it('say so and ask for another try', () => {
    expect(PROBLEM_SAVE).toBe('The list could not be saved. Try again.')
  })
})
