// Whether a marker naming a pid still names a live process, or one the OS
// has since reused for something else -- most likely right after a crash
// and a reboot, exactly when a marker like this is left behind unread.
import { uptime } from 'node:os'

/** A few seconds' slack for the clock/uptime read at write time and at
 * check time landing a second or two apart, on either side of a rounding. */
const BOOT_SLOP_MS = 5000

/** This machine's boot time, rounded to the second: cheap, and the same
 * answer from any process on it, so two markers written by two different
 * processes in the same boot agree without coordinating. */
export function bootTimeMs (now = Date.now(), uptimeSec = uptime()): number {
  return Math.round((now - uptimeSec * 1000) / 1000) * 1000
}

export interface PidRecord {
  readonly pid: number
  /** Absent for a marker written before this existed -- see isPidRecordAlive. */
  readonly bootTime?: number
}

/** Whether the process a marker recorded is still that process. A recorded
 * boot time that differs from the current one by more than BOOT_SLOP_MS means
 * a reboot happened since the marker was written, so its pid is gone whatever
 * `probe` says -- the OS is free to reuse a pid the moment its process exits,
 * and a crash followed by a reboot is exactly the scenario that leaves a
 * marker unread. A marker with no boot time keeps the plain pid probe alone,
 * matching what it did before boot times were recorded. */
export function isPidRecordAlive (record: PidRecord, probe: (pid: number) => boolean, now = Date.now(), uptimeSec = uptime()): boolean {
  if (record.bootTime !== undefined && Math.abs(bootTimeMs(now, uptimeSec) - record.bootTime) > BOOT_SLOP_MS) return false
  return probe(record.pid)
}

/** The plain `process.kill(pid, 0)` probe both callers default to. */
export function processIsAlive (pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists and is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
