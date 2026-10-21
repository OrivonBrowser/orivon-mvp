// The process surface beyond nextTick/emitWarning (globals.test.ts), the
// `global` alias, setImmediate over MessageChannel, and where an uncaught
// callback error goes when no reporter is passed: the page's own.

import { describe, expect, it, vi } from 'vitest'
import { installGlobals, NODE_IDENTITY, VIRTUAL_ROOT, VIRTUAL_TMPDIR, type GlobalsTarget } from '../globals.js'
import { NODE_BUILTIN_EXPORTS } from '../node-builtin-exports.js'

function install (target: GlobalsTarget = {}): GlobalsTarget & { process: NonNullable<GlobalsTarget['process']> } {
  installGlobals({ root: VIRTUAL_ROOT, tmpdir: VIRTUAL_TMPDIR, node: NODE_IDENTITY }, target)
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
  // d-0594: apps are Node-shaped, so the fields a library reads to pick its Node path say Node.
  it('answers the fields libraries read as Node does', () => {
    const { process } = install()
    expect(process.versions).toEqual({ node: NODE_BUILTIN_EXPORTS.nodeVersion })
    expect(process.argv).toEqual([])
    expect(process.execArgv).toEqual([])
    expect(process.execPath).toBe('')
    expect(process.pid).toBeGreaterThan(0)
    expect(process.title).toBe('node')
    expect(process.arch).toBe('x64')
    expect(process.release.name).toBe('node')
    expect(process.umask()).toBe(0o022)
  })

  it('reports the Node version the shim\'s surface is measured against, as Node writes it', () => {
    const { process } = install()
    expect(process.version).toBe(`v${NODE_BUILTIN_EXPORTS.nodeVersion}`)
    expect(process.version).toMatch(/^v\d+\.\d+\.\d+$/)
  })

  it('has no browser flag, so a library guarding on process.browser takes its Node path', () => {
    const { process } = install()
    expect('browser' in process).toBe(false)
    expect((process as unknown as { browser?: unknown }).browser).toBeUndefined()
  })

  it('reports no Electron or Chrome version: those belong to an Electron port\'s own build', () => {
    const { process } = install()
    expect(process.versions['electron']).toBeUndefined()
    expect(process.versions['chrome']).toBeUndefined()
    expect((process as unknown as { type?: unknown }).type).toBeUndefined()
  })

  it('stringifies as Node\'s process does, which is how detect-node-style checks find it', () => {
    const { process } = install()
    expect(Object.prototype.toString.call(process)).toBe('[object process]')
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
