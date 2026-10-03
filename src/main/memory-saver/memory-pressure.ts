// Whether the computer is short of memory, from the figures Electron's `process.getSystemMemoryInfo()` reports. No
// `electron` import: the reading comes in.

/** The part of `Electron.SystemMemoryInfo` this reads, in kilobytes. `available` is the kernel's estimate on Linux,
 * where `free` leaves out the page cache and so is always small. */
export interface MemoryReading {
  readonly total: number
  readonly free: number
  readonly available?: number
}

const ONE_GB_KB = 1024 * 1024

/** Memory is low when what can be allocated is under a tenth of the total, or under one gigabyte, whichever is more. */
export function isMemoryLow (reading: MemoryReading): boolean {
  const left = reading.available ?? reading.free
  if (!Number.isFinite(reading.total) || !Number.isFinite(left) || reading.total <= 0) return false
  return left < Math.max(reading.total / 10, ONE_GB_KB)
}
