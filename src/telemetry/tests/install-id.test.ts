import { describe, expect, it, vi } from 'vitest'
import { HEX32, deriveInstallId, parseIoregOutput, parseMachineIdFile, parseRegOutput, readMachineId, resolveInstallId, type MachineIdReaders } from '../install-id.js'

const MACHINE = '0123456789abcdef0123456789abcdef'

describe('deriveInstallId', () => {
  it('gives 32 hex characters, the same for the same machine and different for another', () => {
    const id = deriveInstallId(MACHINE)
    expect(id).toMatch(HEX32)
    expect(deriveInstallId(MACHINE)).toBe(id)
    expect(deriveInstallId('fedcba9876543210fedcba9876543210')).not.toBe(id)
  })

  it('does not contain the machine identifier', () => {
    expect(deriveInstallId(MACHINE)).not.toContain(MACHINE.slice(0, 8))
  })

  it('ignores case and surrounding whitespace so every reader agrees', () => {
    expect(deriveInstallId(` ${MACHINE.toUpperCase()}\n`)).toBe(deriveInstallId(MACHINE))
  })

  it('is pinned to a known value, so a changed key is noticed', () => {
    expect(deriveInstallId('machine-for-the-pin-0000')).toMatchInlineSnapshot(`"932a3bfc0546cf0f930e90941e272505"`)
  })
})

describe('parsers', () => {
  it('reads the IOPlatformUUID from ioreg output', () => {
    const output = '+-o Root  <class IORegistryEntry>\n    {\n      "IOPlatformUUID" = "564D1E8F-AAAA-4BBB-8CCC-0123456789AB"\n      "IOPlatformSerialNumber" = "C02XYZ"\n    }\n'
    expect(parseIoregOutput(output)).toBe('564D1E8F-AAAA-4BBB-8CCC-0123456789AB')
    expect(parseIoregOutput('nothing here')).toBeUndefined()
  })

  it('reads the MachineGuid from reg output', () => {
    const output = '\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Cryptography\r\n    MachineGuid    REG_SZ    8c1d5a2e-0a3b-4c5d-9e8f-001122334455\r\n\r\n'
    expect(parseRegOutput(output)).toBe('8c1d5a2e-0a3b-4c5d-9e8f-001122334455')
    expect(parseRegOutput('ERROR: The system was unable to find the specified registry key or value.')).toBeUndefined()
  })

  it('reads a machine-id file and refuses an empty or odd one', () => {
    expect(parseMachineIdFile(`${MACHINE}\n`)).toBe(MACHINE)
    expect(parseMachineIdFile('\n')).toBeUndefined()
    expect(parseMachineIdFile('uninitialized')).toBeUndefined()
  })
})

function readers (platform: NodeJS.Platform, files: Record<string, string>, programs: Record<string, string> = {}): MachineIdReaders & { run: ReturnType<typeof vi.fn> } {
  return {
    platform,
    readFile: async (path) => files[path],
    run: vi.fn(async (file: string) => programs[file])
  }
}

describe('readMachineId', () => {
  it('reads /etc/machine-id on Linux, then the dbus copy', async () => {
    expect(await readMachineId(readers('linux', { '/etc/machine-id': MACHINE }))).toBe(MACHINE)
    expect(await readMachineId(readers('linux', { '/var/lib/dbus/machine-id': MACHINE }))).toBe(MACHINE)
    expect(await readMachineId(readers('linux', {}))).toBeUndefined()
  })

  it('asks ioreg on macOS and reg on Windows, and nothing else', async () => {
    const mac = readers('darwin', {}, { ioreg: '"IOPlatformUUID" = "564D1E8F-AAAA-4BBB-8CCC-0123456789AB"' })
    expect(await readMachineId(mac)).toBe('564D1E8F-AAAA-4BBB-8CCC-0123456789AB')
    expect(mac.run).toHaveBeenCalledWith('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'])
    const win = readers('win32', {}, { reg: 'MachineGuid    REG_SZ    8c1d5a2e-0a3b-4c5d-9e8f-001122334455' })
    expect(await readMachineId(win)).toBe('8c1d5a2e-0a3b-4c5d-9e8f-001122334455')
    expect(win.run).toHaveBeenCalledWith('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'])
    expect(await readMachineId(readers('freebsd', {}))).toBeUndefined()
  })
})

describe('resolveInstallId', () => {
  const none = { read: async () => undefined, write: vi.fn(async () => {}) }

  it('derives from the machine identifier and touches no fallback', async () => {
    const fallback = { read: vi.fn(async () => undefined), write: vi.fn(async () => {}) }
    expect(await resolveInstallId(readers('linux', { '/etc/machine-id': MACHINE }), fallback, () => 'x')).toBe(deriveInstallId(MACHINE))
    expect(fallback.read).not.toHaveBeenCalled()
    expect(fallback.write).not.toHaveBeenCalled()
  })

  it('makes a random ID once when no identifier can be read, and keeps it', async () => {
    const write = vi.fn(async () => {})
    const made = 'a'.repeat(32)
    expect(await resolveInstallId(readers('linux', {}), { read: async () => undefined, write }, () => made)).toBe(made)
    expect(write).toHaveBeenCalledWith(made)
    expect(await resolveInstallId(readers('linux', {}), { read: async () => made, write: none.write }, () => 'b'.repeat(32))).toBe(made)
  })

  it('does not trust a kept fallback that is not 32 hex characters', async () => {
    const made = 'c'.repeat(32)
    expect(await resolveInstallId(readers('linux', {}), { read: async () => 'junk', write: async () => {} }, () => made)).toBe(made)
  })
})
