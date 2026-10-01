import { describe, expect, it } from 'vitest'
import { createHttpsExemptions, createFailedUpgrades } from '../https-state.js'

describe('the session exemptions', () => {
  it('remember a host, in any case and with or without the trailing dot', () => {
    const exemptions = createHttpsExemptions()
    exemptions.add('Site.Example.')
    expect(exemptions.has('site.example')).toBe(true)
    expect(exemptions.has('other.example')).toBe(false)
  })
})

describe('the failed upgrades', () => {
  it('keep one address per tab until cleared', () => {
    const failed = createFailedUpgrades()
    failed.set('t1', { from: 'http://a.example/', host: 'a.example' })
    expect(failed.get('t1')?.from).toBe('http://a.example/')
    expect(failed.get('t2')).toBeUndefined()
    failed.clear('t1')
    expect(failed.get('t1')).toBeUndefined()
  })
})
