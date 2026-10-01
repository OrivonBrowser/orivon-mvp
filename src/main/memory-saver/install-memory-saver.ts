// Registered in `../shell/shell-installers.ts`: starts the memory saver once the shell's services exist.
import { powerMonitor } from 'electron'
import type { ShellInstaller } from '../shell/shell-installers.js'
import type { SettingKey } from '../settings/schema.js'
import { sleepTab } from './sleep-tab.js'
import { startMemorySaver } from './start-memory-saver.js'
import type { SleepSettings } from './sleep-rules.js'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

declare global {
  // Test builds only: stamps tabs as last in front `ago` milliseconds back, runs a pass now, and returns the ids
  // it put to sleep. `var` because a `declare global` augmentation needs it.
  var __orivonSweepNow: ((ago?: Record<string, number>) => Promise<string[]>) | undefined
}

const KEYS: readonly SettingKey[] = ['performance.memorySaver', 'performance.sleepAfter', 'performance.keepAwake', 'performance.energySaver']

/** Whether the computer runs on battery. A platform that cannot say reads as mains power. */
function onBattery (): boolean {
  try {
    return powerMonitor.isOnBatteryPower()
  } catch {
    return false
  }
}

export const installMemorySaver: ShellInstaller = {
  name: 'memory-saver',
  install: (_app, services) => {
    const { settings } = services
    const read = (): SleepSettings => ({
      memorySaver: settings.get('performance.memorySaver') === true,
      sleepAfter: String(settings.get('performance.sleepAfter')),
      energySaver: String(settings.get('performance.energySaver'))
    })
    const saver = startMemorySaver({
      lifecycle: services.tabLifecycle,
      windows: () => services.windows.all(),
      findTab: (contents) => services.windows.findTab(contents),
      settings: read,
      onBattery,
      now: () => Date.now(),
      sleep: async (tabs, id) => await sleepTab(tabs, id),
      onSettingChange: (listener) => settings.onChange((change) => { if (KEYS.includes(change.key)) listener() }),
      every: (run, ms) => {
        const timer = setInterval(run, ms)
        timer.unref()
        return { stop: () => { clearInterval(timer) } }
      }
    })
    // Where the OS says so, a change of power source is a pass of its own: tabs idle past the battery wait sleep now.
    const quietly = (): void => { void saver.sweep().catch(() => {}) }
    try {
      powerMonitor.on('on-battery', quietly)
    } catch {
      // The pass each minute reads the power source anyway.
    }
    if (SEAM_ENABLED) {
      globalThis.__orivonSweepNow = async (ago = {}) => {
        const now = Date.now()
        for (const { tabs } of services.windows.all()) {
          for (const [id, ms] of Object.entries(ago)) {
            const record = tabs.record(id)
            if (record !== undefined) record.lastActiveAt = now - ms
          }
        }
        return await saver.sweep()
      }
    }
  }
}
