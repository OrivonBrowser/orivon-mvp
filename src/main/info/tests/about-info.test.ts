import { describe, expect, it } from 'vitest'
import { aboutRows, aboutText, deviceRows, featureRows, featureTone, PRIVATE_PROFILE_TEXT, rawReport, withoutPrivateDirectory } from '../about-info.js'
import type { AboutFacts } from '../about-info.js'

const FACTS: AboutFacts = {
  orivon: '0.4.2',
  electron: '44.0.0',
  chromium: '152.0.7000.1',
  node: '24.1.0',
  v8: '15.2.1',
  platform: 'linux',
  osVersion: '6.8.0',
  arch: 'x64',
  language: 'en-GB',
  userAgent: 'Mozilla/5.0 Chrome/152',
  commandLine: '/opt/orivon/orivon --flag',
  programPath: '/opt/orivon/orivon',
  profilePath: '/home/a/.config/orivon',
  downloadsPath: '/home/a/Downloads',
  commit: 'abcdef012345',
  isPrivate: false
}

describe('the About table', () => {
  it('lists the thirteen rows in order, with the system in one line', () => {
    const rows = aboutRows(FACTS)
    expect(rows.map((row) => row.label)).toEqual([
      'Orivon', 'Commit', 'Electron', 'Chromium', 'Node.js', 'V8', 'Operating system', 'Language',
      'User agent', 'Command line', 'Program location', 'Profile folder', 'Downloads folder'
    ])
    expect(rows.find((row) => row.label === 'Operating system')?.value).toBe('Linux 6.8.0 (x64)')
    expect(rows.find((row) => row.label === 'Orivon')?.value).toBe('0.4.2')
    expect(rows.find((row) => row.label === 'Commit')).toEqual({ label: 'Commit', value: 'abcdef012345', mono: true })
  })

  it('names the operating system for each platform, and an unknown one as reported', () => {
    const system = (platform: string): string | undefined => aboutRows({ ...FACTS, platform, osVersion: '1' }).find((row) => row.label === 'Operating system')?.value
    expect(system('win32')).toBe('Windows 1 (x64)')
    expect(system('darwin')).toBe('macOS 1 (x64)')
    expect(system('freebsd')).toBe('freebsd 1 (x64)')
  })

  it('leaves no stray space when the system version is not known', () => {
    expect(aboutRows({ ...FACTS, osVersion: '' }).find((row) => row.label === 'Operating system')?.value).toBe('Linux (x64)')
  })

  it('says a private window keeps its profile temporarily, instead of a folder', () => {
    const row = aboutRows({ ...FACTS, isPrivate: true }).find((entry) => entry.label === 'Profile folder')
    expect(row).toMatchObject({ value: PRIVATE_PROFILE_TEXT, mono: false })
    expect(PRIVATE_PROFILE_TEXT).toBe('Private window (temporary, deleted when it closes)')
    expect(aboutRows(FACTS).find((entry) => entry.label === 'Profile folder')).toMatchObject({ value: '/home/a/.config/orivon', mono: true })
  })

  it('keeps the temporary profile folder out of a private window\'s command line, in the table and in the copy', () => {
    const commandLine = '/opt/orivon/orivon --orivon-private --orivon-private-dir=/tmp/orivon private x1 --user-data-dir=/tmp/orivon private x1 --flag'
    const rows = aboutRows({ ...FACTS, commandLine, isPrivate: true })
    expect(rows.find((row) => row.label === 'Command line')?.value).toBe('/opt/orivon/orivon --orivon-private --orivon-private-dir=<private> --user-data-dir=<private> --flag')
    expect(aboutText(rows)).not.toContain('/tmp/orivon')
    expect(withoutPrivateDirectory('a --user-data-dir=/x/y')).toBe('a --user-data-dir=<private>')
    expect(aboutRows({ ...FACTS, commandLine, isPrivate: false }).find((row) => row.label === 'Command line')?.value).toBe(commandLine)
  })

  it('copies as one "Label: value" line per row', () => {
    const text = aboutText(aboutRows(FACTS))
    expect(text.split('\n')).toHaveLength(13)
    expect(text.split('\n')[0]).toBe('Orivon: 0.4.2')
    expect(text).toContain('Program location: /opt/orivon/orivon')
  })
})

describe('the graphics feature badges', () => {
  it.each([
    ['enabled', 'Hardware accelerated', 'ok'],
    ['enabled_on', 'Hardware accelerated', 'ok'],
    ['enabled_force', 'Hardware accelerated', 'ok'],
    ['enabled_readback', 'Hardware accelerated', 'ok'],
    ['unavailable_software', 'Software only', 'neutral'],
    ['disabled_software', 'Software only', 'neutral'],
    ['disabled_off', 'Disabled', 'neutral'],
    ['disabled_off_ok', 'Disabled', 'neutral'],
    ['unavailable_off', 'Disabled', 'danger'],
    ['unavailable_off_ok', 'Disabled', 'neutral'],
    ['blocklisted', 'Disabled', 'danger'],
    ['some_new_status', 'some_new_status', 'neutral'],
    ['', 'Unknown', 'neutral']
  ])('reads "%s" as "%s"', (status, text, tone) => {
    expect(featureTone(status)).toEqual({ text, tone })
  })

  it('gives a known feature its label and an unknown one its own key', () => {
    const rows = featureRows({ '2d_canvas': 'enabled', video_decode: 'disabled_software', webgpu: 'disabled_off', brand_new: 'enabled' })
    expect(rows.map((row) => row.label)).toEqual(['Canvas', 'Video decode', 'WebGPU', 'brand_new'])
    expect(rows.map((row) => row.tone)).toEqual(['ok', 'neutral', 'neutral', 'ok'])
  })

  it('skips a value that is not a status string', () => {
    expect(featureRows({ webgl: 'enabled', odd: 7, other: null })).toHaveLength(1)
  })
})

describe('the graphics devices', () => {
  it('reads vendor, device, driver and whether it is in use', () => {
    const rows = deviceRows({ gpuDevice: [
      { active: true, vendorId: 0x10de, deviceId: 0x2684, driverVendor: 'NVIDIA', driverVersion: '550.1' },
      { active: false, vendorId: 0x8086, deviceId: 0x46a6, deviceString: 'UHD Graphics' }
    ] })
    expect(rows[0]).toEqual({ vendor: 'NVIDIA (0x10de)', device: '0x2684', driver: 'NVIDIA 550.1', active: true })
    expect(rows[1]).toEqual({ vendor: 'Intel (0x8086)', device: 'UHD Graphics', driver: 'Not reported', active: false })
  })

  it('shows an unknown vendor by its number, and a device with nothing as unknown', () => {
    expect(deviceRows({ gpuDevice: [{ vendorId: 0x1234 }, {}] })).toEqual([
      { vendor: '(0x1234)', device: 'Unknown', driver: 'Not reported', active: false },
      { vendor: 'Unknown', device: 'Unknown', driver: 'Not reported', active: false }
    ])
  })

  it('returns no rows for a reply that is not a device list', () => {
    expect(deviceRows(undefined)).toEqual([])
    expect(deviceRows({ gpuDevice: 'x' })).toEqual([])
    expect(deviceRows('nope')).toEqual([])
  })

  it('writes the raw report as indented JSON holding both parts', () => {
    const parsed = JSON.parse(rawReport({ webgl: 'enabled' }, undefined)) as { featureStatus: unknown }
    expect(parsed.featureStatus).toEqual({ webgl: 'enabled' })
  })
})
