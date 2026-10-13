import { describe, expect, it } from 'vitest'
import { leavingQuestion } from '../leaving-route-prompt.js'

describe('the question a routed app raises by opening an address', () => {
  it('names the app and the site, and offers the proxy, direct and cancel, in that order', () => {
    const question = leavingQuestion({ kind: 'website', origin: 'https://news.example', app: 'https://routed.example' })
    expect(question.message).toBe('https://routed.example wants to open https://news.example.')
    expect(question.detail).toBe('Your tunnel is on for this app. Open the page through your tunnel, or directly?')
    expect(question.buttons).toEqual(['Through my tunnel', 'Directly', 'Cancel'])
  })

  it('offers to route the other app too when the address is an installed app whose route is off', () => {
    const question = leavingQuestion({ kind: 'app', origin: 'https://other.example', app: 'https://routed.example' })
    expect(question.buttons).toEqual(['Use my tunnel for other.example too', 'Directly', 'Cancel'])
    expect(question.detail).toContain('not for the app it wants to open')
  })

  it('offers a page Orivon loads itself only directly or not at all, and says why', () => {
    const question = leavingQuestion({ kind: 'served', origin: 'ipfs://bafyexample', app: 'https://routed.example' })
    expect(question.message).toBe('https://routed.example wants to open ipfs://bafyexample.')
    expect(question.detail).toBe('Orivon loads this page itself, so it cannot go through your tunnel yet.')
    expect(question.buttons).toEqual(['Directly', 'Cancel'])
  })

  it('shows the deciding end of a long host, as the grant prompt does', () => {
    const question = leavingQuestion({ kind: 'website', origin: 'https://accounts.google.com.attacker.example', app: 'https://routed.example' })
    expect(question.message).toBe('https://routed.example wants to open https://...com.attacker.example.')
  })
})
