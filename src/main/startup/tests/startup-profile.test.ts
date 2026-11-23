import { describe, expect, it } from 'vitest'
import { createStartupProfile, STARTUP_PROFILE_CAP_MS, STARTUP_PROFILE_INTERVAL_US, STARTUP_PROFILE_TAG, startupProfilePath } from '../startup-profile.js'
import type { ProfileAnchor, ProfilerLink, StartupProfileHost, V8Profile } from '../startup-profile.js'

const PROFILE: V8Profile = { startTime: 5_000_000, endTime: 5_420_000, nodes: [{ id: 1 }], samples: [1], timeDeltas: [250] }

interface Fake {
  readonly host: StartupProfileHost
  readonly posted: Array<{ method: string, params: Record<string, unknown> | undefined }>
  readonly written: Array<{ path: string, text: string }>
  readonly logged: Array<{ line: string, level: string }>
  readonly timers: Array<{ run: () => void, ms: number }>
  readonly state: { connected: boolean, disconnects: number }
  /** Answers every call held back by `async`, in order. */
  readonly answer: () => void
}

interface Options {
  /** Hold each protocol call until `answer()`, as an inspector that answers later would. */
  readonly async?: boolean
  readonly openThrows?: boolean
  readonly failOn?: string
  readonly noProfile?: boolean
  readonly writeThrows?: boolean
  readonly anchor?: ProfileAnchor
}

function fake (options: Options = {}): Fake {
  const posted: Fake['posted'] = []
  const written: Fake['written'] = []
  const logged: Fake['logged'] = []
  const timers: Fake['timers'] = []
  const state = { connected: false, disconnects: 0 }
  let held: Array<() => void> = []
  const link: ProfilerLink = {
    connect: () => { state.connected = true },
    disconnect: () => { state.connected = false; state.disconnects++ },
    post: (method, params, callback) => {
      posted.push({ method, params })
      const reply = (): void => {
        if (method === options.failOn) callback(new Error(`${method} refused`))
        else callback(null, method === 'Profiler.stop' && options.noProfile !== true ? { profile: PROFILE } : {})
      }
      if (options.async === true) held.push(reply)
      else reply()
    }
  }
  const host: StartupProfileHost = {
    open: () => {
      if (options.openThrows === true) throw new Error('no inspector in this process')
      return link
    },
    write: (path, text) => {
      if (options.writeThrows === true) throw new Error('disk full')
      written.push({ path, text })
    },
    log: (line, level) => { logged.push({ line, level }) },
    later: (run, ms) => { timers.push({ run, ms }) },
    anchor: () => options.anchor ?? { startMs: 41, base: 'process-creation' }
  }
  const answer = (): void => {
    while (held.length > 0) {
      const next = held
      held = []
      for (const reply of next) reply()
    }
  }
  return { host, posted, written, logged, timers, state, answer }
}

describe('startupProfilePath', () => {
  it('is the file the variable names, trimmed, and null when it is unset or blank', () => {
    expect(startupProfilePath({})).toBeNull()
    expect(startupProfilePath({ ORIVON_STARTUP_PROFILE: '' })).toBeNull()
    expect(startupProfilePath({ ORIVON_STARTUP_PROFILE: '   ' })).toBeNull()
    expect(startupProfilePath({ ORIVON_STARTUP_PROFILE: ' /tmp/start.cpuprofile ' })).toBe('/tmp/start.cpuprofile')
  })
})

describe('createStartupProfile', () => {
  it('enables the profiler, sets the sampling interval and starts, in that order, and is active until it stops', () => {
    const f = fake()
    const profile = createStartupProfile(f.host)
    expect(profile.isActive()).toBe(false)
    profile.start('/tmp/start.cpuprofile')
    expect(f.posted).toEqual([
      { method: 'Profiler.enable', params: undefined },
      { method: 'Profiler.setSamplingInterval', params: { interval: STARTUP_PROFILE_INTERVAL_US } },
      { method: 'Profiler.start', params: undefined }
    ])
    expect(profile.isActive()).toBe(true)
  })

  it('writes the profile V8 returns, with where it began on the start-up line\'s clock, logs one line and lets go of the inspector', () => {
    const f = fake({ anchor: { startMs: 41, base: 'process-creation' } })
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/start.cpuprofile')
    profile.stop('the start-up line printed')
    expect(f.written).toHaveLength(1)
    expect(f.written[0]?.path).toBe('/tmp/start.cpuprofile')
    expect(JSON.parse(f.written[0]?.text ?? '')).toEqual({ ...PROFILE, orivon: { schema: 1, startMs: 41, base: 'process-creation', stoppedBecause: 'the start-up line printed' } })
    expect(f.logged).toEqual([{ level: 'log', line: `${STARTUP_PROFILE_TAG} wrote /tmp/start.cpuprofile: 420 ms of the start, stopped because the start-up line printed` }])
    expect(f.state.connected).toBe(false)
    expect(profile.isActive()).toBe(false)
  })

  it('stops once: a second stop, and a stop that was never preceded by a start, do nothing', () => {
    const idle = fake()
    createStartupProfile(idle.host).stop('too early')
    expect(idle.posted).toEqual([])
    const f = fake()
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/a.cpuprofile')
    profile.stop('first')
    profile.stop('second')
    expect(f.written).toHaveLength(1)
    expect(f.logged).toHaveLength(1)
    expect(f.posted.filter(({ method }) => method === 'Profiler.stop')).toHaveLength(1)
  })

  it('starts once: a second start does not reopen the inspector or change the file', () => {
    const f = fake()
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/a.cpuprofile')
    profile.start('/tmp/b.cpuprofile')
    profile.stop('now')
    expect(f.posted.filter(({ method }) => method === 'Profiler.enable')).toHaveLength(1)
    expect(f.written.map(({ path }) => path)).toEqual(['/tmp/a.cpuprofile'])
  })

  it('stops by itself at the cap, saying so, when the start-up line never prints', () => {
    const f = fake()
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/start.cpuprofile')
    expect(f.timers.map(({ ms }) => ms)).toEqual([STARTUP_PROFILE_CAP_MS])
    f.timers[0]?.run()
    expect(JSON.parse(f.written[0]?.text ?? '').orivon.stoppedBecause).toContain('cap')
    f.timers[0]?.run()
    expect(f.written).toHaveLength(1)
  })

  it('waits for an inspector that answers later, and a stop asked meanwhile is carried out once it has started', () => {
    const f = fake({ async: true })
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/start.cpuprofile')
    profile.stop('asked early')
    expect(f.posted.map(({ method }) => method)).toEqual(['Profiler.enable'])
    f.answer()
    expect(f.posted.map(({ method }) => method)).toEqual(['Profiler.enable', 'Profiler.setSamplingInterval', 'Profiler.start', 'Profiler.stop'])
    expect(f.written).toHaveLength(1)
    expect(JSON.parse(f.written[0]?.text ?? '').orivon.stoppedBecause).toBe('asked early')
  })

  it.each([
    ['the inspector cannot be opened', { openThrows: true }, 'opening the inspector'],
    ['the profiler cannot be enabled', { failOn: 'Profiler.enable' }, 'Profiler.enable'],
    ['the sampling interval is refused', { failOn: 'Profiler.setSamplingInterval' }, 'Profiler.setSamplingInterval'],
    ['the profiler cannot start', { failOn: 'Profiler.start' }, 'Profiler.start']
  ] as const)('is one warning and no file when %s, and a stop afterwards does nothing', (_name, options, what) => {
    const f = fake(options)
    const profile = createStartupProfile(f.host)
    expect(() => { profile.start('/tmp/start.cpuprofile') }).not.toThrow()
    profile.stop('the start-up line printed')
    expect(f.written).toEqual([])
    expect(f.logged).toHaveLength(1)
    expect(f.logged[0]?.level).toBe('warn')
    expect(f.logged[0]?.line).toContain(`${STARTUP_PROFILE_TAG} ${what} failed`)
    expect(f.state.connected).toBe(false)
    expect(profile.isActive()).toBe(false)
  })

  it('is one warning, with the file system\'s reason, when the file cannot be written, and the inspector is let go', () => {
    const f = fake({ writeThrows: true })
    const profile = createStartupProfile(f.host)
    profile.start('/tmp/start.cpuprofile')
    expect(() => { profile.stop('the start-up line printed') }).not.toThrow()
    expect(f.logged).toEqual([{ level: 'warn', line: `${STARTUP_PROFILE_TAG} writing the profile failed, no profile written: disk full` }])
    expect(f.state.connected).toBe(false)
  })

  it('is one warning when the profiler stops with no profile, or the stop is refused', () => {
    for (const options of [{ noProfile: true }, { failOn: 'Profiler.stop' }] as const) {
      const f = fake(options)
      const profile = createStartupProfile(f.host)
      profile.start('/tmp/start.cpuprofile')
      profile.stop('the start-up line printed')
      expect(f.written).toEqual([])
      expect(f.logged).toHaveLength(1)
      expect(f.logged[0]?.level).toBe('warn')
    }
  })

  it('is not stopped by a log that throws or an inspector that will not disconnect', () => {
    const f = fake({ openThrows: true })
    const throwing: StartupProfileHost = { ...f.host, log: () => { throw new Error('console closed') } }
    expect(() => { createStartupProfile(throwing).start('/tmp/start.cpuprofile') }).not.toThrow()
    const stuck = fake()
    const profile = createStartupProfile({ ...stuck.host, open: () => ({ connect: () => {}, disconnect: () => { throw new Error('stuck') }, post: (_method, _params, callback) => { callback(null, { profile: PROFILE }) } }) })
    profile.start('/tmp/start.cpuprofile')
    expect(() => { profile.stop('now') }).not.toThrow()
    expect(stuck.logged).toHaveLength(1)
  })
})
