import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markedRestarter, realInstallHost, stage, swapFile, swapFolder } from '../install-host.js'
import { runInstall } from '../install-update.js'
import type { InstallHost } from '../install-update.js'
import type { InstallPlan } from '../install-plan.js'

function recorder (exitCodes: Record<string, number> = {}, failOn?: string): { host: InstallHost, calls: string[] } {
  const calls: string[] = []
  const note = (name: string): void => { calls.push(name) }
  const maybeFail = (name: string): void => { if (failOn === name) throw new Error(`${name} failed`) }
  return {
    calls,
    host: {
      stage: async (from, to) => { note(`stage ${from}>${to}`); maybeFail('stage') },
      swapFile: async (staged, target) => { note(`swap ${staged}>${target}`); maybeFail('swap') },
      swapFolder: async () => { note('swap-folder'); maybeFail('swap-folder') },
      makeFolder: async (path) => { note(`mkdir ${path}`) },
      remove: async (path) => { note(`rm ${path}`) },
      run: async (command) => { note(`run ${command}`); return exitCodes[command] ?? 0 },
      start: async (command) => { note(`start ${command}`); maybeFail('start') },
      relaunch: (path) => { note(`relaunch ${path}`) },
      quit: () => { note('quit') }
    }
  }
}

const plan: InstallPlan = {
  steps: [
    { op: 'stage', from: 'a', to: 'b', mode: 0o755 },
    { op: 'run', command: 'pk', args: [], declined: [126] },
    { op: 'swap-file', staged: 'b', target: 'c' },
    { op: 'relaunch', execPath: 'c' }
  ],
  onFailure: [{ op: 'remove', path: 'b' }],
  always: [{ op: 'remove', path: 'mnt' }]
}

describe('runInstall', () => {
  it('does the steps in order, cleans up, and only then relaunches and quits', async () => {
    const { host, calls } = recorder()
    expect(await runInstall(plan, host)).toEqual({ ok: true })
    expect(calls).toEqual(['stage a>b', 'run pk', 'swap b>c', 'rm mnt', 'relaunch c'])
  })

  it('quits after the steps for a plan that ends with a quit', async () => {
    const { host, calls } = recorder()
    await runInstall({ steps: [{ op: 'start', command: 'setup', args: [] }, { op: 'quit' }], onFailure: [], always: [] }, host)
    expect(calls).toEqual(['start setup', 'quit'])
  })

  it('stops at a failed step, runs the failure and the always cleanup, and neither relaunches nor quits', async () => {
    const { host, calls } = recorder({}, 'swap')
    const result = await runInstall(plan, host)
    expect(result).toEqual({ ok: false, reason: 'swap failed', declined: false })
    expect(calls).toEqual(['stage a>b', 'run pk', 'swap b>c', 'rm b', 'rm mnt'])
  })

  it('says a program that exits with a declined code was refused by the person, not that it failed', async () => {
    const { host, calls } = recorder({ pk: 126 })
    const result = await runInstall(plan, host)
    expect(result).toEqual({ ok: false, reason: 'You did not allow the installation.', declined: true })
    expect(calls).not.toContain('swap b>c')
    expect(calls).not.toContain('relaunch c')
  })

  it('names the program and the code when it stops with another error', async () => {
    const { host } = recorder({ pk: 1 })
    const result = await runInstall(plan, host)
    expect(result).toEqual({ ok: false, reason: 'pk stopped with an error (exit code 1).', declined: false })
  })

  it('does not quit when the installer could not be started, and says so', async () => {
    const { host, calls } = recorder({}, 'start')
    const result = await runInstall({ steps: [{ op: 'start', command: 'setup', args: [] }, { op: 'quit' }], onFailure: [], always: [] }, host)
    expect(result).toEqual({ ok: false, reason: 'start failed', declined: false })
    expect(calls).toEqual(['start setup'])
  })

  it('says what pkexec\'s exit code means when the step names one, and the generic words otherwise', async () => {
    const steps = [{ op: 'run' as const, command: '/usr/bin/pkexec', args: [], declined: [126], failures: { 127: 'The system refused the installation.' } }]
    const refused = recorder({ '/usr/bin/pkexec': 127 })
    expect(await runInstall({ steps, onFailure: [], always: [] }, refused.host)).toEqual({ ok: false, reason: 'The system refused the installation.', declined: false })
    const other = recorder({ '/usr/bin/pkexec': 1 })
    expect(await runInstall({ steps, onFailure: [], always: [] }, other.host)).toEqual({ ok: false, reason: 'pkexec stopped with an error (exit code 1).', declined: false })
    const dismissed = recorder({ '/usr/bin/pkexec': 126 })
    expect(await runInstall({ steps, onFailure: [], always: [] }, dismissed.host)).toMatchObject({ declined: true })
  })

  it('does not let a cleanup that fails hide the install\'s own result', async () => {
    const { host } = recorder()
    const result = await runInstall({ steps: [{ op: 'relaunch', execPath: 'x' }], onFailure: [], always: [{ op: 'run', command: 'detach', args: [] }] }, { ...host, run: async () => { throw new Error('busy') } })
    expect(result).toEqual({ ok: true })
  })
})

describe('the real file steps', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'orivon-install-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('stages a copy that is executable, replacing a stale one, and leaves the source alone', async () => {
    writeFileSync(join(dir, 'new'), 'new image')
    writeFileSync(join(dir, '.stale'), 'old stage')
    await stage(join(dir, 'new'), join(dir, '.stale'), 0o755)
    expect(readFileSync(join(dir, '.stale'), 'utf8')).toBe('new image')
    expect(statSync(join(dir, '.stale')).mode & 0o777).toBe(0o755)
    expect(readFileSync(join(dir, 'new'), 'utf8')).toBe('new image')
  })

  it('swaps an AppImage by rename: the target keeps its name and takes the new content', async () => {
    writeFileSync(join(dir, 'Orivon.AppImage'), 'v1')
    writeFileSync(join(dir, '.Orivon.AppImage.update'), 'v2')
    await swapFile(join(dir, '.Orivon.AppImage.update'), join(dir, 'Orivon.AppImage'))
    expect(readFileSync(join(dir, 'Orivon.AppImage'), 'utf8')).toBe('v2')
    expect(existsSync(join(dir, '.Orivon.AppImage.update'))).toBe(false)
  })

  it('swaps a folder, keeping the old one until the new one is in and removing it after', async () => {
    mkdirSync(join(dir, 'Orivon.app')); writeFileSync(join(dir, 'Orivon.app', 'v'), 'old')
    mkdirSync(join(dir, '.stage')); writeFileSync(join(dir, '.stage', 'v'), 'new')
    await swapFolder(join(dir, '.stage'), join(dir, 'Orivon.app'), join(dir, '.old'))
    expect(readFileSync(join(dir, 'Orivon.app', 'v'), 'utf8')).toBe('new')
    expect(existsSync(join(dir, '.old'))).toBe(false)
  })

  it('puts the old folder back when the new one cannot take its place', async () => {
    mkdirSync(join(dir, 'Orivon.app')); writeFileSync(join(dir, 'Orivon.app', 'v'), 'old')
    await expect(swapFolder(join(dir, 'missing-stage'), join(dir, 'Orivon.app'), join(dir, '.old'))).rejects.toThrow()
    expect(readFileSync(join(dir, 'Orivon.app', 'v'), 'utf8')).toBe('old')
  })
})

describe('the restarter', () => {
  it('writes the restart note only when the restart is armed, never earlier', async () => {
    const events: string[] = []
    const restarter = markedRestarter({ mark: () => { events.push('mark') }, relaunch: () => { events.push('relaunch') }, quit: () => { events.push('quit') } })
    const { host } = recorder()
    const plan: InstallPlan = { steps: [{ op: 'run', command: 'pk', args: [] }, { op: 'relaunch', execPath: 'c' }, { op: 'quit' }], onFailure: [], always: [] }
    const real = { ...host, run: async () => { events.push('prompt'); return 0 }, relaunch: restarter.relaunch, quit: restarter.quit }
    await runInstall(plan, real)
    expect(events).toEqual(['prompt', 'mark', 'relaunch', 'mark', 'quit'])
  })
})

describe('starting a program that outlives this one', () => {
  it('resolves once it has started', async () => {
    await expect(realInstallHost({ relaunch: () => {}, quit: () => {} }).start(process.execPath, ['-e', ''])).resolves.toBeUndefined()
  })

  it('rejects when it cannot be started, so the browser is not quit for nothing', async () => {
    await expect(realInstallHost({ relaunch: () => {}, quit: () => {} }).start(join(tmpdir(), 'orivon-no-such-installer'), [])).rejects.toThrow()
  })
})
