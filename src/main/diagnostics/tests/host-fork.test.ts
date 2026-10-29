import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostForker } from '../host-fork.js'

class FakeUtility extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
}

const electron = vi.hoisted(() => ({ forks: [] as Array<{ module: string, args: unknown, options: Record<string, unknown>, child: unknown }> }))

vi.mock('electron', () => ({
  utilityProcess: {
    fork: (module: string, args: unknown, options: Record<string, unknown>) => {
      const child = new FakeUtility()
      electron.forks.push({ module, args, options, child })
      return child
    }
  }
}))

const SPEC = { module: '/app/verifier-host.js', serviceName: 'Orivon verifier', prefix: '[verifier]' }

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); electron.forks.length = 0 })

describe('hostForker', () => {
  it('forks the host with its output piped to main, under the name Electron shows', () => {
    const child = hostForker(SPEC)()
    expect(electron.forks).toHaveLength(1)
    expect(electron.forks[0]).toMatchObject({ module: '/app/verifier-host.js', args: [], options: { serviceName: 'Orivon verifier', stdio: 'pipe' } })
    expect(electron.forks[0]?.child).toBe(child)
  })

  it('writes what the host prints to the console main\'s log is captured from, as it is at the moment of the line', () => {
    const fork = hostForker(SPEC)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const child = fork() as unknown as FakeUtility
    child.stderr.emit('data', Buffer.from('[verifier] swarm: a site mounted in 12 ms\n'))
    child.stdout.emit('data', Buffer.from('plain\n'))
    expect(warn).toHaveBeenCalledWith('[verifier] swarm: a site mounted in 12 ms')
    expect(log).toHaveBeenCalledWith('[verifier] plain')
  })

  it('gives every start of the host one allowance of lines, so a host that restarts in a loop cannot flood the log', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fork = hostForker(SPEC)
    const lines = (count: number): Buffer => Buffer.from(Array.from({ length: count }, (_, index) => `line ${String(index)}\n`).join(''))
    const first = fork() as unknown as FakeUtility
    const second = fork() as unknown as FakeUtility
    first.stderr.emit('data', lines(40))
    second.stderr.emit('data', lines(40))
    expect(warn.mock.calls.filter(([text]) => String(text).startsWith('[verifier] line '))).toHaveLength(60)
  })

  it('writes the whole output of a host whose own log switch is on', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = hostForker({ ...SPEC, unlimited: true })() as unknown as FakeUtility
    child.stderr.emit('data', Buffer.from(Array.from({ length: 200 }, (_, index) => `line ${String(index)}\n`).join('')))
    expect(warn).toHaveBeenCalledTimes(200)
  })
})

describe('the forks in src/main', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((path) => path.endsWith('.ts') && !path.endsWith('.test.ts') && !path.split(/[\\/]/).includes('tests'))
    .map((path) => path.replaceAll('\\', '/'))

  it('are all made by hostForker, the one place a utility process is given piped output', () => {
    const forking = sources.filter((path) => /\butilityProcess\s*\.\s*fork\b/.test(readFileSync(join(root, path), 'utf8')))
    expect(forking).toEqual(['diagnostics/host-fork.ts'])
  })

  it('are the verifier host, the local nodes\' host and the Nym tunnel\'s host, each through it', () => {
    for (const path of ['verifier/verifier-subsystem.ts', 'verifier/local-node-launch.ts', 'route/nym-launch.ts']) {
      expect(readFileSync(join(root, path), 'utf8'), path).toMatch(/fork: hostForker\(\{ module: join\(__dirname, '[a-z-]+-host\.js'\)/)
    }
  })
})
