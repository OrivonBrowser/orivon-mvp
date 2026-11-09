import { describe, expect, it } from 'vitest'
import { gsettingsOutput } from './gsettings-output.test-helpers.js'
import { readerFor, readGnomeSettings, readMacosSettings, runCommand } from '../run-readers.js'
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

describe('choosing the reader', () => {
  it('has one for the settings of GNOME and of macOS, and none for the others yet', () => {
    expect(readerFor('gnome')).toBe(readGnomeSettings)
    expect(readerFor('macos')).toBe(readMacosSettings)
    expect(readerFor('environment')).toBeUndefined()
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
