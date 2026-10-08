import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import constants from '../constants.js'

const real = createRequire(import.meta.url)('node:constants') as Record<string, string | number>

describe('constants', () => {
  it('carries the names and values of Node\'s module, which graceful-fs and random-access-file read their open flags from', () => {
    expect(Object.keys(constants).sort()).toEqual(Object.keys(real).sort())
    expect(constants.O_RDWR).toBe(2)
    expect(constants.O_CREAT).toBe(64)
    expect(constants.ENOENT).toBe(2)
    expect(constants.SIGINT).toBe(2)
  })

  it('is data, frozen like the rest of the shim\'s constant tables', () => {
    expect(Object.isFrozen(constants)).toBe(true)
    expect(Object.values(constants).every((value) => typeof value === 'number' || typeof value === 'string')).toBe(true)
  })
})
