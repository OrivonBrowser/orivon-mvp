// What replacing this copy takes, as data. The runner (./install-update.ts) performs the steps; nothing here touches
// the disk or starts a program, so each kind's plan is read and tested without either. Every step that replaces
// files stages first and swaps last, so a failure before the swap leaves the installed copy as it was.
import { basename, dirname, join } from 'node:path/posix'
import type { InstallerKind, InstallFacts } from './install-kind.js'

export type InstallStep =
  /** Copies `from` to `to` and makes it executable. */
  | { readonly op: 'stage', readonly from: string, readonly to: string, readonly mode: number }
  /** Renames `staged` over `target`, atomically: both are in one folder. */
  | { readonly op: 'swap-file', readonly staged: string, readonly target: string }
  /** Replaces a folder by another: the old one is set aside and put back if the new one cannot take its place. */
  | { readonly op: 'swap-folder', readonly staged: string, readonly target: string, readonly backup: string }
  | { readonly op: 'make-folder', readonly path: string }
  | { readonly op: 'remove', readonly path: string }
  /** Waits for the program. An exit code in `declined` means the person refused or cancelled, not that it failed. */
  | { readonly op: 'run', readonly command: string, readonly args: readonly string[], readonly declined?: readonly number[] }
  | { readonly op: 'start', readonly command: string, readonly args: readonly string[] }
  /** Starts `execPath` again once this process has quit, then quits. */
  | { readonly op: 'relaunch', readonly execPath: string }
  | { readonly op: 'quit' }

export interface InstallPlan {
  readonly steps: readonly InstallStep[]
  /** Run after a failed step, each ignoring its own failure: what a half-done install leaves behind. */
  readonly onFailure: readonly InstallStep[]
  /** Run whatever happened, each ignoring its own failure. */
  readonly always: readonly InstallStep[]
}

export interface PlanFacts extends InstallFacts {
  /** A folder made for this install alone, for a mount point. */
  readonly workDir: string
}

export const PKEXEC = '/usr/bin/pkexec'
export const DPKG = '/usr/bin/dpkg'
export const HDIUTIL = '/usr/bin/hdiutil'
export const DITTO = '/usr/bin/ditto'
/** pkexec's exit codes for "the person dismissed the prompt" and "not authorized". */
export const PKEXEC_DECLINED = [126, 127] as const
/** The flags electron-builder's NSIS installer takes to update in place and start the new copy. */
export const NSIS_UPDATE_ARGS = ['--updated', '/S', '--force-run'] as const
const BUNDLE_NAME = 'Orivon.app'

const none: readonly InstallStep[] = []

/** The `.app` folder above the executable of a macOS copy, or undefined when `execPath` is not inside one. */
export function bundleOf (execPath: string): string | undefined {
  const bundle = dirname(dirname(dirname(execPath)))
  return bundle.endsWith('.app') ? bundle : undefined
}

export function installPlan (kind: InstallerKind, file: string, facts: PlanFacts): InstallPlan {
  switch (kind) {
    case 'appimage': {
      const target = facts.appImage ?? ''
      const staged = join(dirname(target), `.${basename(target)}.update`)
      return {
        steps: [
          { op: 'stage', from: file, to: staged, mode: 0o755 },
          { op: 'swap-file', staged, target },
          { op: 'relaunch', execPath: target }
        ],
        onFailure: [{ op: 'remove', path: staged }],
        always: none
      }
    }
    case 'deb':
      return {
        steps: [
          { op: 'run', command: PKEXEC, args: ['--disable-internal-agent', DPKG, '-i', file], declined: PKEXEC_DECLINED },
          { op: 'relaunch', execPath: facts.execPath }
        ],
        onFailure: none,
        always: none
      }
    case 'nsis':
      return { steps: [{ op: 'start', command: file, args: NSIS_UPDATE_ARGS }, { op: 'quit' }], onFailure: none, always: none }
    case 'mac': {
      const bundle = bundleOf(facts.execPath) ?? ''
      const staged = join(dirname(bundle), `.${BUNDLE_NAME}.update`)
      const mount = join(facts.workDir, 'mount')
      return {
        steps: [
          { op: 'make-folder', path: mount },
          { op: 'run', command: HDIUTIL, args: ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file] },
          { op: 'run', command: DITTO, args: [join(mount, BUNDLE_NAME), staged] },
          { op: 'run', command: HDIUTIL, args: ['detach', mount] },
          { op: 'swap-folder', staged, target: bundle, backup: join(dirname(bundle), `.${BUNDLE_NAME}.old`) },
          { op: 'relaunch', execPath: facts.execPath }
        ],
        onFailure: [{ op: 'remove', path: staged }],
        always: [{ op: 'run', command: HDIUTIL, args: ['detach', '-force', mount] }, { op: 'remove', path: mount }]
      }
    }
  }
}

/** What the runner asks of the machine before an install is offered. */
export interface MachineProbe {
  readonly isWritableDir: (path: string) => boolean
  readonly exists: (path: string) => boolean
}

/** Why this copy cannot be replaced from here, or undefined when it can. Checked before the person is asked, so a copy that cannot install is offered the release page alone. */
export function installPreCheck (kind: InstallerKind, facts: InstallFacts, probe: MachineProbe): string | undefined {
  switch (kind) {
    case 'appimage': {
      const target = facts.appImage ?? ''
      if (!probe.exists(target)) return 'The AppImage file is no longer where it was started from.'
      return probe.isWritableDir(dirname(target)) ? undefined : 'The folder this AppImage is in cannot be written to.'
    }
    case 'deb':
      return probe.exists(PKEXEC) && probe.exists(DPKG) ? undefined : 'Installing the package needs pkexec, which this system does not have.'
    case 'nsis':
      return undefined
    case 'mac': {
      const bundle = bundleOf(facts.execPath)
      if (bundle === undefined) return 'Orivon cannot find its own app folder.'
      // macOS runs an app opened from a downloaded disk image or folder from a random read-only place.
      if (bundle.startsWith('/private/var/folders/')) return 'Move Orivon to your Applications folder first: macOS is running it from a temporary place.'
      return probe.isWritableDir(dirname(bundle)) ? undefined : 'The folder Orivon is in cannot be written to.'
    }
  }
}
