import { describe, expect, it } from 'vitest'
import { nameBadgeOf } from '../site-mark.js'

describe('the mark of a name a built-in resolver answers', () => {
  it('is ENS for a .eth name and OG for a .og name, each its own colour', () => {
    expect(nameBadgeOf('vitalik.eth')).toEqual({ text: 'ENS', color: 'ens', title: 'A .eth name' })
    expect(nameBadgeOf('app.linagee.og')).toEqual({ text: 'OG', color: 'og', title: 'A .og name' })
  })

  it('is none for any other host, whatever its last label is called', () => {
    for (const host of ['example.com', 'eth', 'og', 'x.constructor', 'x.__proto__', 'x.eth.limo', '']) expect(nameBadgeOf(host), host).toBeUndefined()
  })
})
