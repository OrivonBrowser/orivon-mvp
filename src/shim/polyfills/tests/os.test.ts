// The `os` module target: os-browserify's answers, with the directories moved
// to the virtual root every other Node-shaped path agrees on.

import { describe, expect, it } from 'vitest'
import os, { cpus, homedir, tmpdir } from '../os.js'
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
    expect(os.platform()).toBe('browser')
    expect(os.endianness()).toBe('LE')
  })

  it('refuses a member it lacks by name, only when called', () => {
    const { userInfo } = os as unknown as { userInfo: () => unknown }
    expect(typeof userInfo).toBe('function')
    expect(() => userInfo()).toThrow(expect.objectContaining({ name: 'OrivonShimError', api: 'os.userInfo' }))
  })
})
