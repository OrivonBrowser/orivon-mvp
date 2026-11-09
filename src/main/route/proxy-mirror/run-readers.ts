// Runs the program that prints a system's proxy settings. Tied to Electron's host only through Node: `execFile`, no shell, a
// time limit, and an error that carries nothing the program printed, because a proxy's password can be in its output.

import { execFile } from 'node:child_process'
import { parseGnomeSettings } from './read-gnome.js'
import { parseMacosSettings } from './read-macos.js'
import type { SettingsSourceName, SystemSettings } from './settings-source.js'

/** A read that takes longer is a read that failed: the sessions stay on the system's own config meanwhile. */
export const READ_TIMEOUT_MS = 3_000
const MOST_OUTPUT_BYTES = 1_048_576

/** Runs `file` with `args` and resolves with what it printed. Rejects with a message that names neither the output nor the arguments. */
export type CommandRunner = (file: string, args: readonly string[]) => Promise<string>

export const runCommand: CommandRunner = async (file, args) => await new Promise<string>((resolve, reject) => {
  const child = execFile(file, [...args], { timeout: READ_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: MOST_OUTPUT_BYTES, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
    if (error === null) resolve(stdout)
    else reject(new Error('the settings program failed or took too long'))
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

/** macOS's proxy settings; `unreadable` when `scutil` fails or prints nothing it can read. */
export async function readMacosSettings (run: CommandRunner = runCommand): Promise<SystemSettings> {
  try {
    return parseMacosSettings(await run('/usr/sbin/scutil', ['--proxy']))
  } catch {
    return { kind: 'unreadable' }
  }
}

/** The read for the settings `source` names, or undefined while no reader for them exists: the mirror then does nothing at all. */
export function readerFor (source: SettingsSourceName): (() => Promise<SystemSettings>) | undefined {
  if (source === 'gnome') return readGnomeSettings
  if (source === 'macos') return readMacosSettings
  return undefined
}
