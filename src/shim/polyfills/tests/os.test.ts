// The `os` module target: os-browserify's answers, with platform, type and arch
// agreeing with `process` and the directories moved to the virtual root every
// other Node-shaped path agrees on.

import { describe, expect, it } from 'vitest'
import os, { cpus, homedir, tmpdir } from '../os.js'
import { NODE_IDENTITY } from '../../node-identity.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../../virtual-root.js'

describe('os', () => {
  it('homedir() and tmpdir() name the virtual root and its tmp folder', () => {
    expect(homedir()).toBe(VIRTUAL_ROOT)
    expect(tmpdir()).toBe(VIRTUAL_TMPDIR)
    expect(os.homedir()).toBe(VIRTUAL_ROOT)
  })

  // `os.cpus().length` sizes worker pools; os-browserify's empty array
  // makes that zero.
  it('cpus() has one entry per logical core the browser reports', () => {
    expect(cpus().length).toBe(Math.max(1, globalThis.navigator?.hardwareConcurrency ?? 1))
    expect(os.availableParallelism()).toBe(cpus().length)
  })

  it('keeps os-browserify\'s own answers for the rest', () => {
    expect(os.EOL).toBe('\n')
    expect(os.endianness()).toBe('LE')
  })

  // d-0594: Node-shaped by default. os and process answer alike, so a library comparing the two sees one machine.
  it('platform(), type() and arch() are the ones process reports', () => {
    expect(os.platform()).toBe(NODE_IDENTITY.platform)
    expect(os.platform()).toBe('linux')
    expect(os.type()).toBe('Linux')
    expect(os.arch()).toBe(NODE_IDENTITY.arch)
    expect(os.arch()).toBe('x64')
  })

  it('refuses a member it lacks by name, only when called', () => {
    const { userInfo } = os as unknown as { userInfo: () => unknown }
    expect(typeof userInfo).toBe('function')
    expect(() => userInfo()).toThrow(expect.objectContaining({ name: 'OrivonShimError', api: 'os.userInfo' }))
  })
})
