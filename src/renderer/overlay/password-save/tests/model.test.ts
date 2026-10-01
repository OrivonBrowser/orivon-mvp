import { describe, expect, it } from 'vitest'
import { offerFrom, SAVED_MS } from '../model.js'

describe('offerFrom', () => {
  it('reads a save or an update offer', () => {
    expect(offerFrom({ kind: 'save', origin: 'https://site.example', username: 'ada' })).toEqual({ kind: 'save', origin: 'https://site.example', username: 'ada' })
    expect(offerFrom({ kind: 'update', origin: 'https://site.example', username: '' })).toEqual({ kind: 'update', origin: 'https://site.example', username: '' })
  })

  it('drops the fields it does not know', () => {
    expect(offerFrom({ kind: 'save', origin: 'https://a.example', username: 'u', password: 'leak' })).toEqual({ kind: 'save', origin: 'https://a.example', username: 'u' })
  })

  it('refuses anything else', () => {
    for (const payload of [undefined, null, 'x', {}, { kind: 'none', origin: 'o', username: 'u' }, { kind: 'save', origin: 1, username: 'u' }, { kind: 'save', origin: 'o' }]) expect(offerFrom(payload)).toBeUndefined()
  })

  it('"Password saved" stays for a second and a half', () => {
    expect(SAVED_MS).toBe(1500)
  })
})
