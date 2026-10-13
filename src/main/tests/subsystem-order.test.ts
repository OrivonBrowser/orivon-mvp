import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// The order of `subsystems.ts` is read from its text: importing the list would start every subsystem's module.
const text = readFileSync(new URL('../subsystems.ts', import.meta.url), 'utf8')
const listed = text.slice(text.indexOf('export const subsystems'))
const at = (name: string): number => listed.search(new RegExp(`^\\s*${name},?(\\s|$)`, 'm'))

describe('the order subsystems start in', () => {
  it('has the route ahead of the extensions, so the default session follows the whole-browser tunnel before the first extension loads into it', () => {
    expect(at('routeSubsystem')).toBeGreaterThan(-1)
    expect(at('extensionsSubsystem')).toBeGreaterThan(-1)
    expect(at('routeSubsystem')).toBeLessThan(at('extensionsSubsystem'))
  })

  it('has the verifier ahead of the extensions too, as its own request listener must exist before any extension loads', () => {
    expect(at('verifierSubsystem')).toBeLessThan(at('extensionsSubsystem'))
  })

  it('keeps the route above the broker, which reads what it publishes', () => {
    expect(at('routeSubsystem')).toBeLessThan(at('brokerIpcSubsystem'))
  })
})
