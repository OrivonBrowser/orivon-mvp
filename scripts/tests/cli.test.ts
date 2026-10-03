import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { commandLine } from '../cli.mjs'

describe('commandLine', () => {
  it('spawns the command directly, with no shell, off Windows', () => {
    expect(commandLine('npx', ['electron-vite', 'build'], 'linux'))
      .toEqual({ file: 'npx', args: ['electron-vite', 'build'], shell: false })
  })

  it('runs an npm .cmd shim through cmd.exe as one string on Windows, never as an args array', () => {
    expect(commandLine('npx', ['vitest', 'run', '--config', 'test/vitest.e2e.config.ts'], 'win32'))
      .toEqual({ file: 'npx vitest run --config test/vitest.e2e.config.ts', args: [], shell: true })
  })

  it('quotes an argument with a space or a shell character on Windows', () => {
    expect(commandLine('node', ['C:\\Users\\A B\\x.mjs', 'a&b', 'say "hi"'], 'win32').file)
      .toBe('node "C:\\Users\\A B\\x.mjs" "a&b" "say ""hi"""')
    expect(commandLine('node', ['C:\\dev\\x.mjs'], 'win32').file).toBe('node C:\\dev\\x.mjs')
  })

  it.runIf(process.platform === 'win32')('launches an npm .cmd shim for real on Windows', () => {
    const line = commandLine('npm', ['--version'])
    const result = spawnSync(line.file, line.args, { shell: line.shell, encoding: 'utf8' })
    expect(result.error).toBeUndefined()
    expect(result.status).toBe(0)
  })
})
