// Finding the private process a browser started: a detached peer is nobody's child, so it is found by its command line.
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export interface PrivatePeer { pids: number[], dir: string, command: string }

/** The private process started for the browser that owns `userData`, with the directory its own command line names. */
export function privatePeer (userData: string): PrivatePeer | undefined {
  const pids = processesWith('--orivon-private', `--user-data-dir=${userData}`)
  for (const pid of pids) {
    let args: string[]
    try { args = readFileSync(join('/proc', String(pid), 'cmdline'), 'utf8').split('\0') } catch { continue }
    const dir = args.find((argument) => argument.startsWith('--orivon-private-dir='))?.replace('--orivon-private-dir=', '')
    if (dir !== undefined && dir !== '') return { pids, dir, command: args.join(' ') }
  }
  return undefined
}

/** Every process whose command line has all of `parts`, by scanning /proc: a detached peer is nobody's child to find. */
export function processesWith (...parts: string[]): number[] {
  const found: number[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const command = readFileSync(join('/proc', name, 'cmdline'), 'utf8')
      if (parts.every((part) => command.includes(part))) found.push(Number(name))
    } catch {
      // Gone, or not ours.
    }
  }
  return found
}
