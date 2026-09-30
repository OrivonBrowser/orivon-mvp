import { describe, expect, it } from 'vitest'
import processModule, * as named from '../process.js'

describe('process module', () => {
  it('is the process global, as require(\'process\') is in Node', () => {
    expect((processModule as unknown as { pid: number }).pid).toBe(process.pid)
    expect(named.env).toBe(process.env)
    expect(named.argv).toBe(process.argv)
    expect(named.platform).toBe(process.platform)
  })

  it('forwards its functions to the global at call time', () => {
    const original = process.cwd
    process.cwd = () => '/patched'
    try {
      expect(named.cwd()).toBe('/patched')
    } finally {
      process.cwd = original
    }
    expect(typeof named.hrtime.bigint()).toBe('bigint')
    expect(named.hrtime()).toHaveLength(2)
  })

  it('nextTick runs a callback with its arguments', async () => {
    const seen = await new Promise<number[]>((resolve) => { named.nextTick((a: unknown, b: unknown) => { resolve([a as number, b as number]) }, 1, 2) })
    expect(seen).toEqual([1, 2])
  })

  it('refuses a member it lacks by name, from the namespace too', () => {
    expect(() => named.binding()).toThrow(/process\.binding/)
  })
})
