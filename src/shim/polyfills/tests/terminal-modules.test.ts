// tty, readline, perf_hooks and console: what each answers at load, and what
// refuses by name.

import { describe, expect, it, vi } from 'vitest'
import { OrivonShimError } from '../../errors.js'
import consoleModule, * as consoleNamespace from '../console.js'
import perfHooks, { performance } from '../perf-hooks.js'
import readline from '../readline.js'
import tty, * as ttyNamespace from '../tty.js'

describe('tty', () => {
  it('has no terminal: isatty is false for every descriptor', () => {
    expect(tty.isatty(0)).toBe(false)
    expect(tty.isatty(1)).toBe(false)
    expect(tty.isatty(2)).toBe(false)
    expect(ttyNamespace.isatty(99)).toBe(false)
  })

  it('refuses the stream classes by name, as not-applicable', () => {
    expect(() => new tty.ReadStream()).toThrow(OrivonShimError)
    expect(() => new ttyNamespace.WriteStream()).toThrow(/tty\.WriteStream/)
    try { new tty.ReadStream() } catch (error) { expect((error as OrivonShimError).reason).toBe('not-applicable') }
  })

  it('refuses a member it does not have when called, never when read', () => {
    const other = (tty as unknown as Record<string, () => void>).getWindowSize
    expect(() => other).not.toThrow()
    expect(() => other!()).toThrow(/tty\.getWindowSize/)
  })
})

describe('readline', () => {
  it('loads, and every function refuses by name when called', () => {
    const rl = readline as unknown as Record<string, () => void>
    expect(() => rl.createInterface).not.toThrow()
    expect(() => rl.createInterface!()).toThrow(OrivonShimError)
    expect(() => rl.createInterface!()).toThrow(/readline\.createInterface/)
  })
})

describe('perf_hooks', () => {
  it('is the platform performance', () => {
    expect(performance).toBe(globalThis.performance)
    expect(perfHooks.performance).toBe(globalThis.performance)
    expect(typeof perfHooks.performance.now()).toBe('number')
    expect(perfHooks.PerformanceObserver).toBe(globalThis.PerformanceObserver)
  })

  it('refuses the event-loop histograms by name', () => {
    expect(() => (perfHooks as unknown as Record<string, () => void>).monitorEventLoopDelay!()).toThrow(/perf_hooks\.monitorEventLoopDelay/)
  })
})

describe('console', () => {
  it('is the global console itself', () => {
    expect(consoleModule).toBe(globalThis.console)
  })

  it('named exports forward at call time, so a patched console answers', () => {
    const spy = vi.spyOn(globalThis.console, 'log').mockImplementation(() => {})
    consoleNamespace.log('a', 1)
    expect(spy).toHaveBeenCalledWith('a', 1)
    spy.mockRestore()
  })

  it('exports a Console that writes to the streams it is given, and refuses members it lacks by name', () => {
    const chunks: string[] = []
    new consoleNamespace.Console({ write: (chunk: string) => { chunks.push(chunk) } }).log('to a stream')
    expect(chunks).toEqual(['to a stream\n'])
    expect(() => { (consoleNamespace as unknown as { profile: () => void }).profile() }).toThrow(/console\.profile/)
  })
})
