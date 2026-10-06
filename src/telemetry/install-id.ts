// One anonymous identity per computer: an HMAC of the operating system's own machine identifier under a
// fixed key, so the same computer gives the same ID from every profile, from a source run and an
// installed run, and after a reinstall, while the identifier itself is never sent and cannot be read
// back from the ID. Pure: the readers of the machine identifier are injected. When none can be read, a
// random ID kept in the system-wide telemetry folder stands in.
import { createHmac } from 'node:crypto'

export const INSTALL_ID_KEY = 'orivon-telemetry-install-v1'

/** The 32 hex characters that stand for `machineId`. */
export function deriveInstallId (machineId: string): string {
  return createHmac('sha256', INSTALL_ID_KEY).update(machineId.trim().toLowerCase()).digest('hex').slice(0, 32)
}

export const HEX32 = /^[0-9a-f]{32}$/

/** `IOPlatformUUID` out of `ioreg -rd1 -c IOPlatformExpertDevice`. */
export function parseIoregOutput (output: string): string | undefined {
  const match = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{8,})"/.exec(output)
  return match?.[1]
}

/** `MachineGuid` out of `reg query HKLM\SOFTWARE\Microsoft\Cryptography /v MachineGuid`. */
export function parseRegOutput (output: string): string | undefined {
  const match = /MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]{8,})/.exec(output)
  return match?.[1]
}

/** The first non-empty line of a Linux machine-id file, if it looks like one. */
export function parseMachineIdFile (content: string): string | undefined {
  const line = content.split('\n').map((text) => text.trim()).find((text) => text.length > 0)
  return line !== undefined && /^[0-9a-fA-F-]{16,}$/.test(line) ? line : undefined
}

export interface MachineIdReaders {
  readonly platform: NodeJS.Platform
  /** Windows' own folder (`%SystemRoot%`), where `reg.exe` is taken from. */
  readonly systemRoot?: string | undefined
  readonly readFile: (path: string) => Promise<string | undefined>
  /** Runs a program with these arguments and no shell, returning its output, or undefined on any failure or timeout. */
  readonly run: (file: string, args: readonly string[]) => Promise<string | undefined>
}

/** The programs are named by absolute path: Windows looks for a bare name in the working directory first, where a downloaded file could stand in for it. */
export const IOREG_PATH = '/usr/sbin/ioreg'

export function regPath (systemRoot: string | undefined): string {
  return `${systemRoot !== undefined && systemRoot !== '' ? systemRoot : 'C:\\Windows'}\\System32\\reg.exe`
}

export async function readMachineId (readers: MachineIdReaders): Promise<string | undefined> {
  if (readers.platform === 'linux') {
    for (const path of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      const content = await readers.readFile(path)
      const id = content === undefined ? undefined : parseMachineIdFile(content)
      if (id !== undefined) return id
    }
    return undefined
  }
  if (readers.platform === 'darwin') {
    const output = await readers.run(IOREG_PATH, ['-rd1', '-c', 'IOPlatformExpertDevice'])
    return output === undefined ? undefined : parseIoregOutput(output)
  }
  if (readers.platform === 'win32') {
    const output = await readers.run(regPath(readers.systemRoot), ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'])
    return output === undefined ? undefined : parseRegOutput(output)
  }
  return undefined
}

export interface FallbackId {
  /** The ID kept in the system-wide folder, if one was made. */
  read: () => Promise<string | undefined>
  write: (id: string) => Promise<void>
}

/** The machine-derived ID, else the kept fallback, else a new random one that is kept. */
export async function resolveInstallId (readers: MachineIdReaders, fallback: FallbackId, random: () => string): Promise<string> {
  const machineId = await readMachineId(readers)
  if (machineId !== undefined) return deriveInstallId(machineId)
  const kept = await fallback.read()
  if (kept !== undefined && HEX32.test(kept)) return kept
  const made = random()
  await fallback.write(made)
  return made
}
