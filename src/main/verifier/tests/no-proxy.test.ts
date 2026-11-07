import { describe, expect, it } from 'vitest'
import { composeNoProxy, exemptFromEnvironmentProxy } from '../no-proxy.js'

describe('composeNoProxy', () => {
  it('lists each suffix as a dot suffix when nothing was there', () => {
    expect(composeNoProxy(undefined, ['eth', 'orivon'])).toBe('.eth,.orivon')
    expect(composeNoProxy('', ['eth'])).toBe('.eth')
    expect(composeNoProxy('  ', ['eth'])).toBe('.eth')
  })

  it('appends after what the person set, leaving it as it was', () => {
    expect(composeNoProxy('localhost,.corp.test', ['eth', 'orivon'])).toBe('localhost,.corp.test,.eth,.orivon')
    expect(composeNoProxy('10.0.0.0/8; *.lan', ['eth'])).toBe('10.0.0.0/8; *.lan,.eth')
  })

  it('does not add a suffix the list already exempts, in any of the forms that name it', () => {
    expect(composeNoProxy('eth', ['eth', 'orivon'])).toBe('eth,.orivon')
    expect(composeNoProxy('.eth', ['eth', 'orivon'])).toBe('.eth,.orivon')
    expect(composeNoProxy('*.eth', ['eth', 'orivon'])).toBe('*.eth,.orivon')
    expect(composeNoProxy('localhost, *.ETH ,.Orivon', ['eth', 'orivon'])).toBe('localhost, *.ETH ,.Orivon')
  })

  it('adds nothing when everything is exempted already', () => {
    expect(composeNoProxy('*', ['eth', 'orivon'])).toBe('*')
  })

  it('does not take a longer name for the suffix', () => {
    expect(composeNoProxy('.corp.eth', ['eth'])).toBe('.corp.eth,.eth')
    expect(composeNoProxy('beth', ['eth'])).toBe('beth,.eth')
  })

  it('drops a trailing separator instead of doubling it, and a suffix named twice is added once', () => {
    expect(composeNoProxy('localhost,', ['eth', 'eth'])).toBe('localhost,.eth')
    expect(composeNoProxy('localhost;  ', ['eth'])).toBe('localhost,.eth')
  })

  it('is stable when applied to its own result', () => {
    const once = composeNoProxy('localhost', ['eth', 'orivon'])
    expect(composeNoProxy(once, ['eth', 'orivon'])).toBe(once)
  })
})

describe('exemptFromEnvironmentProxy', () => {
  it('sets both spellings when neither was', () => {
    const env: Record<string, string | undefined> = {}
    exemptFromEnvironmentProxy(env, ['eth', 'orivon'])
    expect(env).toEqual({ no_proxy: '.eth,.orivon', NO_PROXY: '.eth,.orivon' })
  })

  it('keeps the person\'s list in the spelling it was set in, and gives the other the same list', () => {
    const lower: Record<string, string | undefined> = { no_proxy: 'localhost' }
    exemptFromEnvironmentProxy(lower, ['eth'])
    expect(lower).toEqual({ no_proxy: 'localhost,.eth', NO_PROXY: 'localhost,.eth' })
    const upper: Record<string, string | undefined> = { NO_PROXY: 'localhost' }
    exemptFromEnvironmentProxy(upper, ['eth'])
    expect(upper).toEqual({ no_proxy: 'localhost,.eth', NO_PROXY: 'localhost,.eth' })
  })

  it('adds to each of two different lists without mixing them', () => {
    const env: Record<string, string | undefined> = { no_proxy: 'a.test', NO_PROXY: 'b.test' }
    exemptFromEnvironmentProxy(env, ['eth'])
    expect(env).toEqual({ no_proxy: 'a.test,.eth', NO_PROXY: 'b.test,.eth' })
  })

  it('leaves every other variable alone, and gives the same result when run twice', () => {
    const env: Record<string, string | undefined> = { https_proxy: 'http://proxy.test:3128', HOME: '/home/x' }
    exemptFromEnvironmentProxy(env, ['eth'])
    const after = { ...env }
    exemptFromEnvironmentProxy(env, ['eth'])
    expect(env).toEqual(after)
    expect(env['https_proxy']).toBe('http://proxy.test:3128')
    expect(env['HOME']).toBe('/home/x')
  })
})
