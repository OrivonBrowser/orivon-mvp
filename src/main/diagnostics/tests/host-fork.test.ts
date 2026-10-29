import { EventEmitter } from 'node:events'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { hostForker } from '../host-fork.js'
import { HOST_LINES_PER_MINUTE, HOST_TAIL_ENTRIES } from '../host-output.js'
import { LOG_RING_LINES } from '../log-ring.js'

class FakeUtility extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
}

const electron = vi.hoisted(() => ({
  forks: [] as Array<{ module: string, args: unknown, options: Record<string, unknown>, child: unknown }>,
  quit: [] as Array<{ event: string, listener: () => void }>
}))

vi.mock('electron', () => ({
  app: { prependListener: (event: string, listener: () => void) => { electron.quit.push({ event, listener }) } },
  utilityProcess: {
    fork: (module: string, args: unknown, options: Record<string, unknown>) => {
      const child = new FakeUtility()
      electron.forks.push({ module, args, options, child })
      return child
    }
  }
}))

const SPEC = { module: '/app/verifier-host.js', serviceName: 'Orivon verifier', prefix: '[verifier]' }

const lines = (count: number): Buffer => Buffer.from(Array.from({ length: count }, (_, index) => `line ${String(index)}\n`).join(''))

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); electron.forks.length = 0; electron.quit.length = 0 })

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
    const first = fork() as unknown as FakeUtility
    const second = fork() as unknown as FakeUtility
    first.stderr.emit('data', lines(40))
    second.stderr.emit('data', lines(40))
    expect(warn.mock.calls.filter(([text]) => String(text).startsWith('[verifier] line '))).toHaveLength(60)
  })

  it('writes the whole output of a host whose own log switch is on, a line that repeats included', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = hostForker({ ...SPEC, unlimited: true })() as unknown as FakeUtility
    child.stderr.emit('data', lines(200))
    child.stderr.emit('data', Buffer.from('same\n'.repeat(20)))
    expect(warn).toHaveBeenCalledTimes(220)
  })

  it('writes what a host held back when the app quits, from one listener placed ahead of the others', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fork = hostForker(SPEC)
    const child = fork() as unknown as FakeUtility
    fork()
    expect(electron.quit.map(({ event }) => event)).toEqual(['will-quit'])
    child.stderr.emit('data', lines(HOST_LINES_PER_MINUTE + 10))
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('came in the last minute'))
    electron.quit[0]?.listener()
    expect(warn).toHaveBeenCalledWith(`[verifier] 10 more lines came in the last minute after the first ${String(HOST_LINES_PER_MINUTE)}; the last ${String(HOST_TAIL_ENTRIES)} entries of them follow`)
    expect(warn).toHaveBeenLastCalledWith(`[verifier] line ${String(HOST_LINES_PER_MINUTE + 9)}`)
  })

  it('leaves out what a library in the host prints when asked to, unless the host\'s whole output is wanted', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const nym = { module: '/app/nym-tunnel-host.js', serviceName: 'Orivon Nym tunnel', prefix: '[nym-tunnel]', onlyTagged: 'the Nym library' }
    const own = hostForker(nym)() as unknown as FakeUtility
    own.stderr.emit('data', Buffer.from('[tcp] connecting to a.example:443\n[nym-tunnel] a SOCKS5 connection failed: refused\n'))
    expect(warn.mock.calls.map(([text]) => String(text))).toEqual(['[nym-tunnel] a SOCKS5 connection failed: refused'])
    const all = hostForker({ ...nym, unlimited: true })() as unknown as FakeUtility
    all.stderr.emit('data', Buffer.from('[tcp] connecting to a.example:443\n'))
    expect(warn).toHaveBeenLastCalledWith('[nym-tunnel] [tcp] connecting to a.example:443')
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

  it('give each host its own LOG switch, and the Nym tunnel\'s host the rule that its library\'s lines are left out', () => {
    expect(readFileSync(join(root, 'verifier/verifier-subsystem.ts'), 'utf8')).toMatch(/hostForker\(\{[^\n]*unlimited: process\.env\['ORIVON_VERIFIER_LOG'\] === '1'/)
    expect(readFileSync(join(root, 'verifier/local-node-launch.ts'), 'utf8')).toMatch(/hostForker\(\{[^\n]*unlimited: process\.env\[envName\(spec\.kind\.name, 'LOG'\)\] === '1'/)
    expect(readFileSync(join(root, 'route/nym-launch.ts'), 'utf8')).toMatch(/hostForker\(\{[^\n]*unlimited: logging, onlyTagged: 'the Nym library'/)
  })

  it('are few enough that every host at its allowance, and what it says of the rest, fill under a third of the ring in a minute', () => {
    const read = (path: string): string => readFileSync(join(root, path), 'utf8')
    const own = sources.filter((path) => path !== 'verifier/local-node-launch.ts' && path !== 'diagnostics/host-fork.ts' && /\bhostForker\(\{/.test(read(path)))
    // One fork call serves every kind of local node: each kind is a subsystem of its own.
    const nodes = sources.filter((path) => path !== 'verifier/local-node-subsystem.ts' && /\bcreateLocalNodeSubsystem\(\{/.test(read(path)))
    expect([...own, ...nodes].sort()).toEqual(['route/nym-launch.ts', 'verifier/ipfs-node-subsystem.ts', 'verifier/swarm-node-subsystem.ts', 'verifier/verifier-subsystem.ts'])
    // The marker and the count each add a line; the kept entries are taken as one line each (a stack is several).
    const perHost = HOST_LINES_PER_MINUTE + 2 + HOST_TAIL_ENTRIES
    expect(HOST_LINES_PER_MINUTE * (own.length + nodes.length)).toBeLessThan(LOG_RING_LINES / 4)
    expect(perHost * (own.length + nodes.length)).toBeLessThan(LOG_RING_LINES / 3)
  })
})
