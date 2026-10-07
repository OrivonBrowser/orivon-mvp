import { buildDiagnostics } from '../diagnostics-facts.js'
import type { DiagnosticsFacts } from '../diagnostics-facts.js'
import type { CrashRecord } from '../crash-records.js'
import type { ReportChoices, ReportSources } from '../report-payload.js'

export const HOME = '/home/ann'

export const CRASH: CrashRecord = {
  id: '0123456789abcdef',
  sessionId: 'session-1',
  kind: 'renderer',
  at: '2026-10-07T11:00:00Z',
  process: 'tab',
  reason: 'crashed',
  exitCode: 133,
  message: 'The page died at /home/ann/secret.html',
  stack: 'Error: x\n    at f (/home/ann/git/orivon/src/a.ts:1:1)',
  page: 'https://example.org/path?q=1'
}

export const FACTS: DiagnosticsFacts = {
  commit: 'abcdef012345',
  channel: 'source',
  versions: { electron: '44.0.0', chromium: '150.0.0.0', node: '24.0.0', v8: '15.0' },
  packaged: false,
  uptimeSec: 12.4,
  system: { platform: 'linux', release: '7.0.0', arch: 'x64', cpus: 8, cpuModel: 'Test CPU', memoryMb: 16000, freeMemoryMb: 8000, locale: 'en-US', session: 'wayland', desktop: 'GNOME', ozone: '' },
  gpuStatus: { webgl: 'enabled', gpu_compositing: 'disabled_software', note: 3 },
  gpuInfo: { gpuDevice: [{ vendorId: 32902, deviceId: 4680, driverVersion: '25.1', active: true, deviceString: 'ignored' }, {}] },
  displays: [{ width: 1920, height: 1080, scaleFactor: 1.25 }],
  processes: [{ type: 'Tab', workingSetKb: 2048 }, { type: 'Tab', workingSetKb: 1024 }, { type: 'GPU', workingSetKb: 512 }],
  browser: { windows: 1, tabs: 3, privateSession: false, extensions: [{ id: 'abc', name: 'Ext', version: '1.0', enabled: true }], settings: { 'appearance.theme': 'system' } },
  crashes: [CRASH]
}

export const CHOICES: ReportChoices = { crashId: CRASH.id, description: '  It crashed.  ', contact: ' ann@example.org ', diagnostics: true, log: true, page: true, dump: true }

export function sources (overrides: Partial<ReportSources> = {}): ReportSources {
  return {
    reportId: 'f'.repeat(32),
    version: '0.1.0',
    home: HOME,
    ignoreCase: false,
    choices: CHOICES,
    crash: CRASH,
    diagnostics: buildDiagnostics(FACTS),
    log: ['2026-10-07T11:00:00.000Z LOG hello /home/ann/x', '2026-10-07T11:00:01.000Z ERROR bad'],
    dump: { bytes: 4, base64: () => 'AAECAw==' },
    ...overrides
  }
}
