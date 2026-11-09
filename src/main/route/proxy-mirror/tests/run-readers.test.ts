import { describe, expect, it } from 'vitest'
import { gsettingsOutput } from './gsettings-output.test-helpers.js'
import { readGnomeSettings, runCommand } from '../run-readers.js'

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
