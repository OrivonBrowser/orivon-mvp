// Performs an install plan (./install-plan.ts) step by step through a host, and says how it ended. The host is the
// only part that touches the disk or starts a program, so the order, the cleanup and the wording of a failure are
// tested with a recording host.
import { basename } from 'node:path/posix'
import type { InstallPlan, InstallStep } from './install-plan.js'

export interface InstallHost {
  readonly stage: (from: string, to: string, mode: number) => Promise<void>
  readonly swapFile: (staged: string, target: string) => Promise<void>
  readonly swapFolder: (staged: string, target: string, backup: string) => Promise<void>
  readonly makeFolder: (path: string) => Promise<void>
  readonly remove: (path: string) => Promise<void>
  /** The program's exit code; rejects when it cannot be started. */
  readonly run: (command: string, args: readonly string[]) => Promise<number>
  /** Starts a program that outlives this process; resolves once it has started and rejects when it could not be. */
  readonly start: (command: string, args: readonly string[]) => Promise<void>
  /** Arranges for `execPath` to start once this process has quit. */
  readonly relaunch: (execPath: string) => void
  readonly quit: () => void
}

export type InstallResult =
  | { readonly ok: true }
  | { readonly ok: false, readonly reason: string, /** The person dismissed or refused the system's prompt. */ readonly declined: boolean }

class Declined extends Error {}

async function perform (step: InstallStep, host: InstallHost): Promise<void> {
  switch (step.op) {
    case 'stage': return await host.stage(step.from, step.to, step.mode)
    case 'swap-file': return await host.swapFile(step.staged, step.target)
    case 'swap-folder': return await host.swapFolder(step.staged, step.target, step.backup)
    case 'make-folder': return await host.makeFolder(step.path)
    case 'remove': return await host.remove(step.path)
    case 'start': return await host.start(step.command, step.args)
    case 'run': {
      const code = await host.run(step.command, step.args)
      if (code === 0) return
      if (step.declined?.includes(code) === true) throw new Declined('You did not allow the installation.')
      throw new Error(step.failures?.[code] ?? `${basename(step.command)} stopped with an error (exit code ${String(code)}).`)
    }
    case 'relaunch': host.relaunch(step.execPath); return
    case 'quit': host.quit()
  }
}

const quietly = async (steps: readonly InstallStep[], host: InstallHost): Promise<void> => {
  for (const step of steps) await perform(step, host).catch(() => {})
}

const isEnding = (step: InstallStep): boolean => step.op === 'relaunch' || step.op === 'quit'

/**
 * Runs `plan`. Relaunching and quitting wait until the cleanup that always runs is done, and happen only after every
 * other step succeeded; a failed step runs the failure cleanup and leaves this copy running.
 */
export async function runInstall (plan: InstallPlan, host: InstallHost): Promise<InstallResult> {
  let failure: InstallResult | undefined
  try {
    for (const step of plan.steps.filter((entry) => !isEnding(entry))) await perform(step, host)
  } catch (error) {
    await quietly(plan.onFailure, host)
    failure = { ok: false, reason: error instanceof Error ? error.message : 'The update could not be installed.', declined: error instanceof Declined }
  }
  await quietly(plan.always, host)
  if (failure !== undefined) return failure
  try {
    for (const step of plan.steps.filter(isEnding)) await perform(step, host)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'The update could not be restarted.', declined: false }
  }
  return { ok: true }
}
