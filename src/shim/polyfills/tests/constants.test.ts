import * as nodeFs from 'node:fs'
import { createRequire } from 'node:module'
import * as nodeOs from 'node:os'
import { describe, expect, it } from 'vitest'
import constants from '../constants.js'

const real = createRequire(import.meta.url)('node:constants') as Record<string, string | number>

describe('constants', () => {
  it('carries the names and values of Node\'s module, which graceful-fs and random-access-file read their open flags from', () => {
    // The UV_* and crypto names vary with the build (a Node patch release, Windows), so they are compared where
    // both have them; every open flag, mode, errno and signal name must be here.
    const fsFlags = Object.fromEntries(Object.entries(nodeFs.constants).filter(([name]) => /^(O_|S_|[FRWX]_OK$)/.test(name)))
    const required = { ...fsFlags, ...nodeOs.constants.errno, ...nodeOs.constants.signals }
    for (const [name, value] of Object.entries(required)) expect(constants[name], name).toBe(value)
    for (const [name, value] of Object.entries(real)) if (name in constants) expect(constants[name], name).toBe(value)
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
