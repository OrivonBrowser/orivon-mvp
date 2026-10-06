import { describe, expect, it } from 'vitest'
import { DPKG, installPlan, installPreCheck, NSIS_UPDATE_ARGS, PKEXEC } from '../install-plan.js'
import type { PlanFacts } from '../install-plan.js'

const facts = (patch: Partial<PlanFacts> = {}): PlanFacts =>
  ({ platform: 'linux', arch: 'x64', isPackaged: true, appImage: '/home/p/apps/Orivon.AppImage', execPath: '/opt/Orivon/orivon', debOwned: false, workDir: '/tmp/orivon-update-1', ...patch })
const probe = (existing: string[], writable: string[]): { exists: (p: string) => boolean, isWritableDir: (p: string) => boolean } =>
  ({ exists: (path) => existing.includes(path), isWritableDir: (path) => writable.includes(path) })

describe('installPlan', () => {
  it('replaces an AppImage by staging beside it, swapping by rename and starting the same path', () => {
    const plan = installPlan('appimage', '/ud/pending-update/a.AppImage', facts())
    expect(plan.steps).toEqual([
      { op: 'stage', from: '/ud/pending-update/a.AppImage', to: '/home/p/apps/.Orivon.AppImage.update', mode: 0o755 },
      { op: 'swap-file', staged: '/home/p/apps/.Orivon.AppImage.update', target: '/home/p/apps/Orivon.AppImage' },
      { op: 'relaunch', execPath: '/home/p/apps/Orivon.AppImage' }
    ])
    expect(plan.onFailure).toEqual([{ op: 'remove', path: '/home/p/apps/.Orivon.AppImage.update' }])
  })

  it('installs a deb through pkexec with its own agent off, an argument array and the declined exit codes', () => {
    const plan = installPlan('deb', '/ud/pending-update/o.deb', facts())
    expect(plan.steps).toEqual([
      { op: 'run', command: PKEXEC, args: ['--disable-internal-agent', DPKG, '-i', '/ud/pending-update/o.deb'], declined: [126, 127] },
      { op: 'relaunch', execPath: '/opt/Orivon/orivon' }
    ])
  })

  it('hands the Windows installer the update flags and quits, leaving the start to it', () => {
    const plan = installPlan('nsis', 'C:\\ud\\Orivon-Setup.exe', facts({ platform: 'win32' }))
    expect(plan.steps).toEqual([{ op: 'start', command: 'C:\\ud\\Orivon-Setup.exe', args: [...NSIS_UPDATE_ARGS] }, { op: 'quit' }])
    expect(NSIS_UPDATE_ARGS).toEqual(['--updated', '/S', '--force-run'])
  })

  it('mounts the disk image read-only, copies the app beside the old one, swaps folders and always detaches', () => {
    const plan = installPlan('mac', '/ud/o.dmg', facts({ platform: 'darwin', execPath: '/Applications/Orivon.app/Contents/MacOS/Orivon' }))
    expect(plan.steps.map((step) => step.op)).toEqual(['make-folder', 'run', 'run', 'run', 'swap-folder', 'relaunch'])
    expect(plan.steps[1]).toEqual({ op: 'run', command: 'hdiutil', args: ['attach', '-nobrowse', '-readonly', '-mountpoint', '/tmp/orivon-update-1/mount', '/ud/o.dmg'] })
    expect(plan.steps[2]).toEqual({ op: 'run', command: 'ditto', args: ['/tmp/orivon-update-1/mount/Orivon.app', '/Applications/.Orivon.app.update'] })
    expect(plan.steps[4]).toEqual({ op: 'swap-folder', staged: '/Applications/.Orivon.app.update', target: '/Applications/Orivon.app', backup: '/Applications/.Orivon.app.old' })
    expect(plan.always).toEqual([{ op: 'run', command: 'hdiutil', args: ['detach', '-force', '/tmp/orivon-update-1/mount'] }, { op: 'remove', path: '/tmp/orivon-update-1/mount' }])
    expect(plan.onFailure).toEqual([{ op: 'remove', path: '/Applications/.Orivon.app.update' }])
  })

  it('never builds a command from a shell string', () => {
    for (const kind of ['appimage', 'deb', 'nsis', 'mac'] as const) {
      for (const step of installPlan(kind, '/ud/a b; rm -rf x', facts({ execPath: '/Applications/Orivon.app/Contents/MacOS/Orivon' })).steps) {
        if (step.op === 'run' || step.op === 'start') expect(Array.isArray(step.args)).toBe(true)
      }
    }
  })
})

describe('installPreCheck', () => {
  it('lets an AppImage update when its folder is writable and the file is there', () => {
    const f = facts()
    expect(installPreCheck('appimage', f, probe([f.appImage ?? ''], ['/home/p/apps']))).toBeUndefined()
    expect(installPreCheck('appimage', f, probe([f.appImage ?? ''], []))).toMatch(/cannot be written/)
    expect(installPreCheck('appimage', f, probe([], ['/home/p/apps']))).toMatch(/no longer/)
  })

  it('needs pkexec and dpkg for a deb', () => {
    expect(installPreCheck('deb', facts(), probe([PKEXEC, DPKG], []))).toBeUndefined()
    expect(installPreCheck('deb', facts(), probe([DPKG], []))).toMatch(/pkexec/)
  })

  it('has nothing to ask of the machine for the Windows installer', () => {
    expect(installPreCheck('nsis', facts({ platform: 'win32' }), probe([], []))).toBeUndefined()
  })

  it('refuses a macOS copy that runs from a translocated place, an unwritable folder, or no app folder', () => {
    const at = (execPath: string): PlanFacts => facts({ platform: 'darwin', execPath })
    expect(installPreCheck('mac', at('/Applications/Orivon.app/Contents/MacOS/Orivon'), probe([], ['/Applications']))).toBeUndefined()
    expect(installPreCheck('mac', at('/private/var/folders/x/AppTranslocation/Orivon.app/Contents/MacOS/Orivon'), probe([], ['/private/var/folders/x/AppTranslocation']))).toMatch(/Applications/)
    expect(installPreCheck('mac', at('/Applications/Orivon.app/Contents/MacOS/Orivon'), probe([], []))).toMatch(/cannot be written/)
    expect(installPreCheck('mac', at('/usr/bin/orivon'), probe([], []))).toMatch(/app folder/)
  })
})
