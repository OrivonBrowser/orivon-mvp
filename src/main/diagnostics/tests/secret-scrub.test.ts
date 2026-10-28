import { afterEach, describe, expect, it } from 'vitest'
import { forgetSecrets, noteSecret, scrub, scrubDeep } from '../secret-scrub.js'

afterEach(() => { forgetSecrets() })

describe('scrub', () => {
  it('leaves text alone while no secret is noted', () => {
    expect(scrub('GET https://mainnet.infura.io/v3/KEY failed')).toBe('GET https://mainnet.infura.io/v3/KEY failed')
  })

  it('replaces a noted secret wherever it appears, as many times as it appears', () => {
    noteSecret('FAKE-KEY-0123456789')
    expect(scrub('a FAKE-KEY-0123456789 b FAKE-KEY-0123456789 c')).toBe('a •••• b •••• c')
  })

  it('shows what the note says in its place', () => {
    noteSecret('https://mainnet.infura.io/v3/FAKE-KEY-0123456789', 'https://mainnet.infura.io/••••')
    noteSecret('/v3/FAKE-KEY-0123456789')
    noteSecret('FAKE-KEY-0123456789')
    expect(scrub('fetch https://mainnet.infura.io/v3/FAKE-KEY-0123456789 failed; path /v3/FAKE-KEY-0123456789; key FAKE-KEY-0123456789')).toBe('fetch https://mainnet.infura.io/•••• failed; path ••••; key ••••')
  })

  it('takes the longest secret first, whatever order they were noted in', () => {
    noteSecret('FAKE-KEY-0123456789')
    noteSecret('https://mainnet.infura.io/v3/FAKE-KEY-0123456789', 'https://mainnet.infura.io/••••')
    expect(scrub('https://mainnet.infura.io/v3/FAKE-KEY-0123456789')).toBe('https://mainnet.infura.io/••••')
  })

  it('does not take a short string for a secret, which would blank ordinary words', () => {
    noteSecret('/v3')
    noteSecret('')
    expect(scrub('the /v3 path')).toBe('the /v3 path')
  })

  it('remembers a secret for the whole run, so a key the person removed is still scrubbed from a line printed later', () => {
    noteSecret('FAKE-KEY-0123456789')
    noteSecret('ANOTHER-KEY-9876543210')
    expect(scrub('FAKE-KEY-0123456789 ANOTHER-KEY-9876543210')).toBe('•••• ••••')
  })

  it('keeps the newest secrets once there are more than it holds', () => {
    for (let i = 0; i < 300; i++) noteSecret(`secret-number-${String(i).padStart(4, '0')}`)
    expect(scrub('secret-number-0299')).toBe('••••')
    expect(scrub('secret-number-0000')).toBe('secret-number-0000')
  })
})

describe('scrubDeep', () => {
  it('scrubs every string inside an object or an array, and nothing else', () => {
    noteSecret('FAKE-KEY-0123456789')
    const value = { a: 'x FAKE-KEY-0123456789', b: ['FAKE-KEY-0123456789', 5, null, true], c: { d: 'FAKE-KEY-0123456789' }, e: 7 }
    expect(scrubDeep(value)).toEqual({ a: 'x ••••', b: ['••••', 5, null, true], c: { d: '••••' }, e: 7 })
  })

  it('hands back the very same value while no secret is noted', () => {
    const value = { a: 'x' }
    expect(scrubDeep(value)).toBe(value)
  })
})
