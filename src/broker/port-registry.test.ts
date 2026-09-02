import { describe, expect, it } from 'vitest'
import { createPortRegistry } from './port-registry.js'

const APP = 'https://app.example'
const OTHER = 'https://other.example'

describe('createPortRegistry', () => {
  it('returns a value registered under the same origin and id', () => {
    const registry = createPortRegistry<{ label: string }>()
    registry.register(APP, 'handle-1', { label: 'first' })

    expect(registry.get(APP, 'handle-1')).toEqual({ label: 'first' })
  })

  it('returns undefined for an id nothing ever registered', () => {
    const registry = createPortRegistry<string>()

    expect(registry.get(APP, 'never-registered')).toBeUndefined()
  })

  it('returns undefined for an origin that never registered anything', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'handle-1', 'value')

    expect(registry.get(OTHER, 'handle-1')).toBeUndefined()
  })

  // THE SECURITY PROPERTY net.close depends on: a renderer that somehow
  // learns another origin's handle id (a guess, a leaked log line) must not
  // be able to reach that origin's resource through this registry.
  it('does not return a value registered under a DIFFERENT origin, even with the same id', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'shared-id', 'apps-value')
    registry.register(OTHER, 'shared-id', 'others-value')

    expect(registry.get(APP, 'shared-id')).toBe('apps-value')
    expect(registry.get(OTHER, 'shared-id')).toBe('others-value')
  })

  it('keeps two ids registered under the same origin independent', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'handle-1', 'first')
    registry.register(APP, 'handle-2', 'second')

    expect(registry.get(APP, 'handle-1')).toBe('first')
    expect(registry.get(APP, 'handle-2')).toBe('second')
  })

  it('removing a value makes it unreachable afterward', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'handle-1', 'value')

    registry.remove(APP, 'handle-1')

    expect(registry.get(APP, 'handle-1')).toBeUndefined()
  })

  it('remove is a silent no-op for an id that was never registered', () => {
    const registry = createPortRegistry<string>()

    expect(() => { registry.remove(APP, 'never-registered') }).not.toThrow()
  })

  it('remove is a silent no-op for an origin that never registered anything', () => {
    const registry = createPortRegistry<string>()

    expect(() => { registry.remove(OTHER, 'handle-1') }).not.toThrow()
  })

  it('removing one id leaves a sibling id under the same origin intact', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'handle-1', 'first')
    registry.register(APP, 'handle-2', 'second')

    registry.remove(APP, 'handle-1')

    expect(registry.get(APP, 'handle-1')).toBeUndefined()
    expect(registry.get(APP, 'handle-2')).toBe('second')
  })

  it('an origin can register again under an id after removing it', () => {
    const registry = createPortRegistry<string>()
    registry.register(APP, 'handle-1', 'first')
    registry.remove(APP, 'handle-1')

    registry.register(APP, 'handle-1', 'second')

    expect(registry.get(APP, 'handle-1')).toBe('second')
  })
})
