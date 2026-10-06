import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_BASE_URL, TELEMETRY_BASE_URL, endpointUrl, ingestBaseUrl, modeInputsFromEnv, telemetryHome, telemetryOffReason, testOverrides } from '../mode.js'

describe('telemetryOffReason', () => {
  const on = { development: false, disabledByEnv: false, privateSession: false }

  it('runs in an ordinary session and a development run, and in neither of the other two', () => {
    expect(telemetryOffReason(on)).toBeUndefined()
    expect(telemetryOffReason({ ...on, development: true })).toBeUndefined()
    expect(telemetryOffReason({ ...on, disabledByEnv: true })).toBe('env')
    expect(telemetryOffReason({ ...on, privateSession: true })).toBe('private')
  })
})

describe('modeInputsFromEnv', () => {
  it('reads developer mode, the electron-vite dev server and ORIVON_TELEMETRY=off', () => {
    expect(modeInputsFromEnv({}, false, false)).toEqual({ development: false, disabledByEnv: false, privateSession: false })
    expect(modeInputsFromEnv({}, true, false).development).toBe(true)
    expect(modeInputsFromEnv({ ELECTRON_RENDERER_URL: 'http://localhost:5173' }, false, false).development).toBe(true)
    expect(modeInputsFromEnv({ ELECTRON_RENDERER_URL: '' }, false, false).development).toBe(false)
    expect(modeInputsFromEnv({ ORIVON_TELEMETRY: 'off' }, false, false).disabledByEnv).toBe(true)
    expect(modeInputsFromEnv({ ORIVON_TELEMETRY: 'on' }, false, false).disabledByEnv).toBe(false)
  })
})

describe('telemetryHome', () => {
  const base = { userData: '/home/a/.config/orivon', appData: '/home/a/.config', overrideHome: undefined, development: false, testBuild: false }

  it('is the system-wide folder in an ordinary build', () => {
    expect(telemetryHome(base)).toBe('/home/a/.config/orivon-telemetry')
  })

  it('stays inside the profile in a development run, and ignores any override there', () => {
    expect(telemetryHome({ ...base, development: true, overrideHome: '/x' })).toBe('/home/a/.config/orivon/telemetry-home')
  })

  it('uses the override in a test build, else the profile, and never the system folder', () => {
    expect(telemetryHome({ ...base, testBuild: true, overrideHome: '/tmp/h' })).toBe('/tmp/h')
    expect(telemetryHome({ ...base, testBuild: true })).toBe('/home/a/.config/orivon/telemetry-home')
    expect(telemetryHome({ ...base, testBuild: true, overrideHome: '' })).toBe('/home/a/.config/orivon/telemetry-home')
  })
})

describe('ingestBaseUrl', () => {
  it('is the real address in an ordinary build, whatever the environment says', () => {
    expect(ingestBaseUrl(false, 'http://127.0.0.1:9/', false)).toBe(TELEMETRY_BASE_URL)
    expect(TELEMETRY_BASE_URL).toBe('https://telemetry.orivonstack.com/v1/')
  })

  it('is an address that cannot answer in a development run, so nothing reaches the server', () => {
    expect(ingestBaseUrl(false, undefined, true)).toBe(DEVELOPMENT_BASE_URL)
    expect(ingestBaseUrl(true, 'http://example.com/', true)).toBe(DEVELOPMENT_BASE_URL)
    expect(new URL(DEVELOPMENT_BASE_URL).hostname.endsWith('.invalid')).toBe(true)
  })

  it('takes a loopback http address in a test build, and nothing else', () => {
    expect(ingestBaseUrl(true, 'http://127.0.0.1:4100/v1', false)).toBe('http://127.0.0.1:4100/v1/')
    expect(ingestBaseUrl(true, 'http://localhost:4100/', true)).toBe('http://localhost:4100/')
    for (const bad of ['https://127.0.0.1/', 'http://example.com/', 'http://192.168.1.2/', 'nope', undefined]) {
      expect(ingestBaseUrl(true, bad, false)).toBe(TELEMETRY_BASE_URL)
    }
  })

  it('names the three endpoints', () => {
    expect(['usage', 'sites', 'erase'].map((name) => endpointUrl(TELEMETRY_BASE_URL, name as 'usage'))).toEqual([
      'https://telemetry.orivonstack.com/v1/usage', 'https://telemetry.orivonstack.com/v1/sites', 'https://telemetry.orivonstack.com/v1/erase'
    ])
  })
})

describe('testOverrides', () => {
  it('reads nothing outside a test build, which is every unit test', () => {
    expect(testOverrides({ ORIVON_TELEMETRY_HOME: '/x', ORIVON_TELEMETRY_URL: 'http://127.0.0.1:1', ORIVON_TELEMETRY_TICK_MS: '100', ORIVON_TELEMETRY_ASSUME_ACTIVE: '1' })).toEqual({ home: undefined, url: undefined, tickMs: undefined, assumeActive: false })
  })
})
