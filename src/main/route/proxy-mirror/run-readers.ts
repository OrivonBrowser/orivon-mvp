// Runs the program that prints a system's proxy settings. Tied to Electron's host only through Node: `execFile`, no shell, a
// time limit, and an error that carries nothing the program printed, because a proxy's password can be in its output.

import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { parseGnomeSettings } from './read-gnome.js'
import { parseWindowsSettings } from './read-windows.js'
import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** A read that takes longer is a read that failed: the sessions stay on the system's own config meanwhile. */
export const READ_TIMEOUT_MS = 3_000
const MOST_OUTPUT_BYTES = 1_048_576

/** A program that failed. `exitCode` is the program's own; undefined when it never started or was killed for taking too long. */
export class CommandFailed extends Error {
  constructor (readonly exitCode: number | undefined) {
    super('the settings program failed or took too long')
  }
}

/** Runs `file` with `args` and resolves with what it printed. Rejects with a `CommandFailed`, whose message names neither the output nor the arguments. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>

export const runCommand: CommandRunner = async (file, args) => await new Promise<string>((resolve, reject) => {
  const child = execFile(file, [...args], { timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MOST_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
    if (error === null) resolve(stdout)
    else reject(new CommandFailed(typeof error.code === 'number' && !error.killed ? error.code : undefined))
  })
  child.stdin?.end()
})

/** GNOME's proxy settings; `unreadable` when `gsettings` is missing, fails, or says nothing it can read. */
export async function readGnomeSettings (run: CommandRunner = runCommand): Promise<SystemSettings> {
  try {
    return parseGnomeSettings(await run('gsettings', ['list-recursively', 'org.gnome.system.proxy']))
  } catch {
    return { kind: 'unreadable' }
  }
}

const INTERNET_SETTINGS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const SETTINGS_POLICY = 'HKLM\\Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** One `reg query`: what it printed, or undefined when `reg` says the key or value is not there (exit code 1). Any other failure rejects. */
async function registryQuery (run: CommandRunner, reg: string, key: string, value?: string): Promise<string | undefined> {
  try {
    return await run(reg, value === undefined ? ['query', key] : ['query', key, '/v', value])
  } catch (error) {
    if (error instanceof CommandFailed && error.exitCode === 1) return undefined
    throw error
  }
}

/** Windows' proxy settings; `unreadable` when `reg.exe` fails, takes too long, or prints no Internet Settings key. */
export async function readWindowsSettings (run: CommandRunner = runCommand, systemRoot: string | undefined = process.env['SystemRoot']): Promise<SystemSettings> {
  const reg = win32.join(systemRoot ?? 'C:\\Windows', 'System32', 'reg.exe')
  try {
    const [values, blob, policy] = await Promise.all([
      registryQuery(run, reg, INTERNET_SETTINGS),
      registryQuery(run, reg, `${INTERNET_SETTINGS}\\Connections`, 'DefaultConnectionSettings'),
      registryQuery(run, reg, SETTINGS_POLICY, 'ProxySettingsPerUser')
    ])
    return parseWindowsSettings({ values, blob, policy })
  } catch {
    return { kind: 'unreadable' }
  }
}

/** The reader for the computer's settings, or undefined where none exists yet: the mirror then does nothing at all. */
export function readerFor (source: SettingsSourceName): (() => Promise<SystemSettings>) | undefined {
  if (source === 'gnome') return readGnomeSettings
  if (source === 'windows') return readWindowsSettings
  return undefined
}
