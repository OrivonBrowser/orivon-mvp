import { describe, expect, it } from 'vitest'
import { gsettingsOutput } from './gsettings-output.test-helpers.js'
import { blobHex, connectionBlob, internetSettings, perUserPolicy } from './reg-output.test-helpers.js'
import { CommandFailed, readGnomeSettings, readMacosSettings, readWindowsSettings, runCommand } from '../run-readers.js'
import { HTTP_AND_HTTPS } from './scutil-output.test-helpers.js'

describe('reading GNOME\'s settings', () => {
  it('asks gsettings for the proxy schema, recursively, and parses what it prints', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const settings = await readGnomeSettings(async (file, args) => {
      calls.push([file, args])
      return gsettingsOutput({ mode: 'manual', http: { host: 'proxy.test', port: 3128 } })
    })
    expect(calls).toEqual([['gsettings', ['list-recursively', 'org.gnome.system.proxy']]])
    expect(settings).toMatchObject({ kind: 'manual', proxyRules: 'http=proxy.test:3128' })
  })

  it('is unreadable when the program fails, is missing or takes too long', async () => {
    expect(await readGnomeSettings(async () => { throw new Error('the settings program failed or took too long') })).toEqual({ kind: 'unreadable' })
  })

  it('is unreadable when the program prints what is no settings', async () => {
    expect(await readGnomeSettings(async () => 'garbage')).toEqual({ kind: 'unreadable' })
  })
})

describe('reading macOS\'s settings', () => {
  it('asks scutil by its absolute path for the proxy dictionary and parses what it prints', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const settings = await readMacosSettings(async (file, args) => {
      calls.push([file, args])
      return HTTP_AND_HTTPS
    })
    expect(calls).toEqual([['/usr/sbin/scutil', ['--proxy']]])
    expect(settings).toMatchObject({ kind: 'manual', proxyRules: 'http=127.0.0.1:18082;https=127.0.0.1:18082' })
  })

  it('is unreadable when the program fails, is missing or takes too long', async () => {
    expect(await readMacosSettings(async () => { throw new Error('the settings program failed or took too long') })).toEqual({ kind: 'unreadable' })
  })

  it('is unreadable when the program prints what is no settings', async () => {
    expect(await readMacosSettings(async () => 'garbage')).toEqual({ kind: 'unreadable' })
  })
})

describe('running a program', () => {
  it('rejects with a message that names neither the program\'s output nor its arguments', async () => {
    const error = await runCommand('/nonexistent/orivon-settings-program', ['--password=hunter2']).then(() => undefined, (failure: unknown) => failure as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error?.message).not.toContain('hunter2')
    expect(error?.message).not.toContain('nonexistent')
  })

  it('resolves with what the program printed', async () => {
    expect(await runCommand(process.execPath, ['-e', "process.stdout.write('printed')"])).toBe('printed')
  })
})

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

describe('reading Windows\' settings', () => {
  /** A `reg` that answers each query from `answers` by its key and value, and fails with the exit code `reg` gives for a missing one when it has no answer. */
  const registry = (answers: { values?: string, blob?: string, policy?: string }, calls: Array<[string, readonly string[]]> = []) => async (file: string, args: readonly string[]): Promise<string> => {
    calls.push([file, args])
    const answer = args[1]?.startsWith('HKLM') === true ? answers.policy : args[2] === '/v' ? answers.blob : answers.values
    if (answer === undefined) throw new CommandFailed(1)
    return answer
  }

  it('asks reg.exe of the system folder for the key, the connection blob and the policy, and parses what it prints', async () => {
    const calls: Array<[string, readonly string[]]> = []
    const settings = await readWindowsSettings(registry({ values: internetSettings({ enable: 1, server: 'proxy.test:3128' }), blob: connectionBlob(blobHex(3, 'proxy.test:3128')) }, calls), 'D:\\Win')
    expect(settings).toMatchObject({ kind: 'manual', proxyRules: 'proxy.test:3128' })
    expect([...calls].sort()).toEqual([
      ['D:\\Win\\System32\\reg.exe', ['query', KEY]],
      ['D:\\Win\\System32\\reg.exe', ['query', `${KEY}\\Connections`, '/v', 'DefaultConnectionSettings']],
      ['D:\\Win\\System32\\reg.exe', ['query', 'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxySettingsPerUser']]
    ].sort())
  })

  it('takes a blob or a policy that is not there as none, and the policy as it is when it is', async () => {
    expect(await readWindowsSettings(registry({ values: internetSettings({ enable: 1, server: 'proxy.test:3128' }) }), 'C:\\Windows')).toMatchObject({ kind: 'manual' })
    expect(await readWindowsSettings(registry({ values: internetSettings({ enable: 1, server: 'proxy.test:3128' }), policy: perUserPolicy(0) }), 'C:\\Windows')).toEqual({ kind: 'unsupported' })
  })

  it('is unreadable when the key is not there, when reg.exe fails otherwise, is missing or takes too long', async () => {
    expect(await readWindowsSettings(registry({}), 'C:\\Windows')).toEqual({ kind: 'unreadable' })
    for (const failure of [new CommandFailed(5), new CommandFailed(undefined), new Error('anything')]) {
      expect(await readWindowsSettings(async () => { throw failure }, 'C:\\Windows')).toEqual({ kind: 'unreadable' })
    }
    let calls = 0
    expect(await readWindowsSettings(async () => {
      calls += 1
      if (calls === 2) throw new CommandFailed(undefined)
      return internetSettings({ enable: 1, server: 'proxy.test:3128' })
    }, 'C:\\Windows')).toEqual({ kind: 'unreadable' })
  })

  it('looks for reg.exe in C:\\Windows when the environment names no system folder', async () => {
    const calls: string[] = []
    await readWindowsSettings(async (file) => { calls.push(file); throw new CommandFailed(1) }, undefined)
    expect(calls).toEqual(Array(3).fill('C:\\Windows\\System32\\reg.exe'))
  })
})

describe('a program that failed', () => {
  it('carries its exit code, and nothing when it never started', async () => {
    const exited = await runCommand(process.execPath, ['-e', 'process.exit(3)']).then(() => undefined, (failure: unknown) => failure as CommandFailed)
    expect(exited).toBeInstanceOf(CommandFailed)
    expect(exited?.exitCode).toBe(3)
    const missing = await runCommand('/nonexistent/orivon-settings-program', []).then(() => undefined, (failure: unknown) => failure as CommandFailed)
    expect(missing?.exitCode).toBeUndefined()
  })
})
