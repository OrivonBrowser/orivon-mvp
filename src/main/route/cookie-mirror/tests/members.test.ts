import { describe, expect, it } from 'vitest'
import { joinsMirror } from '../members.js'

describe('which sessions the mirror keeps in step with the default', () => {
  it('takes the kept session of each profile', () => {
    expect(joinsMirror('persist:tunnel-profile', false)).toBe(true)
    expect(joinsMirror('persist:proxy-profile', false)).toBe(true)
    expect(joinsMirror('persist:direct-profile', false)).toBe(true)
  })

  it('leaves the profiles that live in memory alone', () => {
    expect(joinsMirror('tunnel-profile-memory', false)).toBe(false)
    expect(joinsMirror('proxy-profile-memory', false)).toBe(false)
    expect(joinsMirror('direct-profile-memory', false)).toBe(false)
  })

  it('leaves an app\'s session, an internal one, a temporary one and the default alone', () => {
    expect(joinsMirror('persist:app-3f9a0c', false)).toBe(false)
    expect(joinsMirror('persist:site-3f9a0c', false)).toBe(false)
    expect(joinsMirror('orivon-system-proxy', false)).toBe(false)
    expect(joinsMirror('persist:orivon-shell', false)).toBe(false)
    expect(joinsMirror(undefined, false)).toBe(false)
  })

  it('takes nothing in a private window\'s process', () => {
    expect(joinsMirror('persist:tunnel-profile', true)).toBe(false)
    expect(joinsMirror('persist:direct-profile', true)).toBe(false)
  })
})
