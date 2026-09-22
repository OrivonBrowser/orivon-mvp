// The process surface beyond nextTick/emitWarning (globals.test.ts), the
// `global` alias, setImmediate over MessageChannel, and where an uncaught
// callback error goes when no reporter is passed: the page's own.

import { describe, expect, it, vi } from 'vitest'
import { installGlobals, VIRTUAL_ROOT, VIRTUAL_TMPDIR, type GlobalsTarget } from '../globals.js'

function install (target: GlobalsTarget = {}): GlobalsTarget & { process: NonNullable<GlobalsTarget['process']> } {
  installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR }, target)
  if (target.process === undefined) throw new Error('setup failed')
  return target as GlobalsTarget & { process: NonNullable<GlobalsTarget['process']> }
}

describe('global', () => {
  it('is the target itself, installed as a replaceable property', () => {
    const target = install()
    expect(target.global).toBe(target)
    expect(Object.getOwnPropertyDescriptor(target, 'global')).toMatchObject({ writable: true, configurable: true, enumerable: true })
  })
})

describe('process fields', () => {
  it('answers the fields libraries read, without claiming to be Node', () => {
    const { process } = install()
    expect(process.versions).toEqual({})
    expect(process.versions['node']).toBeUndefined()
    expect(process.argv).toEqual([])
    expect(process.execArgv).toEqual([])
    expect(process.pid).toBeGreaterThan(0)
    expect(process.title).toBe('browser')
    expect(process.arch).toBe('javascript')
    expect(process.release.name).not.toBe('node')
    expect(process.umask()).toBe(0o022)
  })

  it('hrtime is monotonic, takes a previous reading, and has a bigint form', () => {
    const { process } = install()
    const first = process.hrtime()
    const delta = process.hrtime(first)
    expect(delta[0]).toBeGreaterThanOrEqual(0)
    expect(delta[1]).toBeGreaterThanOrEqual(0)
    expect(delta[1]).toBeLessThan(1e9)
    expect(typeof process.hrtime.bigint()).toBe('bigint')
    expect(process.uptime()).toBeGreaterThan(0)
    expect(typeof process.memoryUsage().heapUsed).toBe('number')
  })

  it('stdout and stderr write a line to the console', () => {
    const { process } = install()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      expect(process.stdout.write('hello\n')).toBe(true)
      expect(log).toHaveBeenCalledWith('hello')
    } finally {
      log.mockRestore()
    }
    expect(process.stderr.fd).toBe(2)
    expect(process.stdout.isTTY).toBe(false)
  })

  it('exit emits \'exit\' and then throws a named error', () => {
    const { process } = install()
    const onExit = vi.fn()
    process.on('exit', onExit)
    expect(() => process.exit(3)).toThrow(expect.objectContaining({ name: 'OrivonShimError', api: 'process.exit' }))
    expect(onExit).toHaveBeenCalledWith(3)
    expect(process.exitCode).toBe(3)
  })
})

describe('process as an event emitter', () => {
  it('on/once/off/emit behave as EventEmitter\'s do', () => {
    const { process } = install()
    const always = vi.fn()
    const once = vi.fn()
    process.on('custom', always).once('custom', once)
    expect(process.listenerCount('custom')).toBe(2)
    expect(process.emit('custom', 1)).toBe(true)
    expect(process.emit('custom', 2)).toBe(true)
    expect(always).toHaveBeenCalledTimes(2)
    expect(once).toHaveBeenCalledExactlyOnceWith(1)
    process.off('custom', always)
    expect(process.emit('custom')).toBe(false)
  })

  it('an \'uncaughtException\' listener receives a nextTick error instead of the page', async () => {
    const pageReportError = vi.fn()
    const { process } = install({ reportError: pageReportError })
    const handler = vi.fn()
    process.on('uncaughtException', handler)
    const boom = new Error('boom')
    process.nextTick(() => { throw boom })
    await Promise.resolve()
    expect(handler).toHaveBeenCalledWith(boom, 'uncaughtException')
    expect(pageReportError).not.toHaveBeenCalled()
  })
})

describe('with no reporter passed', () => {
  // The preload passes none, so the page's own reportError is what fires
  // window 'error' for the app's own handlers, not the preload's console.
  it('a nextTick or setImmediate error goes to the page\'s own reportError', async () => {
    const pageReportError = vi.fn()
    const target = install({ reportError: pageReportError })
    const tickError = new Error('tick')
    const immediateError = new Error('immediate')
    target.process.nextTick(() => { throw tickError })
    target.setImmediate?.(() => { throw immediateError })
    await vi.waitFor(() => { expect(pageReportError).toHaveBeenCalledTimes(2) })
    expect(pageReportError).toHaveBeenNthCalledWith(1, tickError)
    expect(pageReportError).toHaveBeenNthCalledWith(2, immediateError)
  })

  it('a warning goes to a \'warning\' listener, else to the page console', () => {
    const { process } = install()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      process.emitWarning('first')
      expect(warn).toHaveBeenCalledOnce()
      const listener = vi.fn()
      process.on('warning', listener)
      process.emitWarning('second')
      expect(listener).toHaveBeenCalledOnce()
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})

describe('setImmediate over MessageChannel', () => {
  it('never schedules through setTimeout, so no timer clamp applies', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const target = install()
      const ran = vi.fn()
      target.setImmediate?.(ran)
      await vi.waitFor(() => { expect(ran).toHaveBeenCalled() })
      expect(setTimeoutSpy).not.toHaveBeenCalled()
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('runs callbacks in the order they were queued, one task each', async () => {
    const target = install()
    const order: number[] = []
    for (const n of [1, 2, 3]) target.setImmediate?.(() => order.push(n))
    await vi.waitFor(() => { expect(order).toEqual([1, 2, 3]) })
  })
})
