import { describe, expect, it } from 'vitest'
import { buildDiagnostics, channelOf, REPORTED_SETTINGS, reportedSettings } from '../diagnostics-facts.js'
import type { CrashRecord } from '../crash-records.js'
import { CRASH, FACTS } from './report-fixtures.js'

describe('buildDiagnostics', () => {
  const diagnostics = buildDiagnostics(FACTS)

  it('has the groups the notice describes, in order, and nothing else', () => {
    expect(Object.keys(diagnostics)).toEqual(['app', 'system', 'gpu', 'displays', 'processes', 'browser', 'recentCrashes'])
    expect(Object.keys(diagnostics.app)).toEqual(['commit', 'channel', 'electron', 'chromium', 'node', 'v8', 'packaged', 'uptimeSec'])
    expect(Object.keys(diagnostics.system)).toEqual(['platform', 'release', 'arch', 'cpus', 'cpuModel', 'memoryMb', 'freeMemoryMb', 'locale', 'session', 'desktop', 'ozone'])
    expect(Object.keys(diagnostics.browser)).toEqual(['windows', 'tabs', 'privateSession', 'extensions', 'settings'])
  })

  it('rounds the uptime to whole seconds', () => {
    expect(diagnostics.app.uptimeSec).toBe(12)
  })

  it('keeps only the string entries of the graphics feature status, and reads each device\'s four facts', () => {
    expect(diagnostics.gpu.features).toEqual({ webgl: 'enabled', gpu_compositing: 'disabled_software' })
    expect(diagnostics.gpu.devices).toEqual([{ vendorId: 32902, deviceId: 4680, driverVersion: '25.1', active: true }, { vendorId: 0, deviceId: 0, driverVersion: '', active: false }])
  })

  it('has no devices when the graphics report is unavailable', () => {
    expect(buildDiagnostics({ ...FACTS, gpuInfo: undefined, gpuStatus: undefined }).gpu).toEqual({ features: {}, devices: [] })
  })

  it('groups the processes by type with their memory in MB', () => {
    expect(diagnostics.processes).toEqual([{ type: 'Tab', count: 2, memoryMb: 3 }, { type: 'GPU', count: 1, memoryMb: 1 }])
  })

  it('names the displays by size and scale', () => {
    expect(diagnostics.displays).toEqual([{ width: 1920, height: 1080, scale: 1.25 }])
  })

  it('lists the newest ten local crashes without their message, stack or page', () => {
    const many: CrashRecord[] = Array.from({ length: 15 }, (_, index) => ({ ...CRASH, id: index.toString(16).padStart(16, '0'), at: `2026-10-07T10:${String(index).padStart(2, '0')}:00Z` }))
    const { recentCrashes } = buildDiagnostics({ ...FACTS, crashes: many })
    expect(recentCrashes).toHaveLength(10)
    expect(recentCrashes[0]?.at).toBe('2026-10-07T10:14:00Z')
    expect(Object.keys(recentCrashes[0] ?? {})).toEqual(['kind', 'at', 'process', 'reason', 'exitCode'])
  })
})

describe('channelOf', () => {
  const base = { development: false, packaged: true, platform: 'linux', appImage: false }
  it('names how this copy runs', () => {
    expect(channelOf({ ...base, development: true })).toBe('development')
    expect(channelOf({ ...base, packaged: false })).toBe('source')
    expect(channelOf({ ...base, appImage: true })).toBe('appimage')
    expect(channelOf(base)).toBe('linux-package')
    expect(channelOf({ ...base, platform: 'win32' })).toBe('windows')
    expect(channelOf({ ...base, platform: 'darwin' })).toBe('macos')
  })
})

describe('reportedSettings', () => {
  it('lists the allowlist, and every web3 switch or choice, and no setting that is an address or text', () => {
    for (const key of ['appearance.theme', 'privacy.secureDns', 'web3.lightClient', 'web3.ethGatewayRedirect', 'updates.check', 'developer.tools']) expect(REPORTED_SETTINGS).toContain(key)
    for (const key of ['web3.scoreProvider', 'home.url', 'startup.pages', 'downloads.folder', 'performance.keepAwake']) expect(REPORTED_SETTINGS).not.toContain(key)
  })

  it('reads values only, and skips anything that is not a string or a flag', () => {
    const values = reportedSettings((key) => key === 'privacy.secureDns' ? 'quad9' : key === 'appearance.theme' ? 3 : true)
    expect(values['privacy.secureDns']).toBe('quad9')
    expect(values).not.toHaveProperty('appearance.theme')
    expect(values['web3.lightClient']).toBe(true)
  })
})
