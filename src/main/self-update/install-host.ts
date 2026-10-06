// The real machine behind ./install-update.ts: files are copied and renamed, programs are run by argument array and
// never through a shell. Takes no Electron: how to relaunch and quit comes in.
import { execFile, spawn } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { chmod, copyFile, mkdir, rename, rm } from 'node:fs/promises'
import type { InstallHost } from './install-update.js'
import type { MachineProbe } from './install-plan.js'

/** Puts `staged` where `target` is in one rename, so a reader of `target` sees the old file or the new, never half of one. */
export async function swapFile (staged: string, target: string): Promise<void> {
  await rename(staged, target)
}

/** Sets the old folder aside, moves the new one in, and puts the old one back if that fails. */
export async function swapFolder (staged: string, target: string, backup: string): Promise<void> {
  await rm(backup, { recursive: true, force: true })
  await rename(target, backup)
  try {
    await rename(staged, target)
  } catch (error) {
    await rename(backup, target).catch(() => {})
    throw error
  }
  await rm(backup, { recursive: true, force: true })
}

export async function stage (from: string, to: string, mode: number): Promise<void> {
  await rm(to, { force: true })
  await copyFile(from, to)
  await chmod(to, mode)
}

export const machineProbe: MachineProbe = {
  exists: (path) => { try { accessSync(path); return true } catch { return false } },
  isWritableDir: (path) => { try { accessSync(path, constants.W_OK); return true } catch { return false } }
}

export interface Restarter {
  readonly relaunch: (execPath: string) => void
  readonly quit: () => void
}

/** A restarter that writes the one-shot restart note at the moment the restart is armed and again as the browser quits, never earlier: a password prompt that takes minutes cannot age it. */
export function markedRestarter (deps: Restarter & { readonly mark: () => void }): Restarter {
  return {
    relaunch: (execPath) => { deps.mark(); deps.relaunch(execPath) },
    quit: () => { deps.mark(); deps.quit() }
  }
}

export function realInstallHost (restarter: Restarter): InstallHost {
  return {
    stage,
    swapFile,
    swapFolder,
    makeFolder: async (path) => { await mkdir(path, { recursive: true }) },
    remove: async (path) => { await rm(path, { recursive: true, force: true }) },
    run: async (command, args) => await new Promise<number>((resolve, reject) => {
      execFile(command, [...args], { windowsHide: true }, (error) => {
        if (error === null) resolve(0)
        else if (typeof (error as { code?: unknown }).code === 'number') resolve((error as unknown as { code: number }).code)
        else reject(error)
      })
    }),
    start: async (command, args) => await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [...args], { detached: true, stdio: 'ignore', windowsHide: true })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    }),
    relaunch: restarter.relaunch,
    quit: restarter.quit
  }
}
