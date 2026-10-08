// The devices the person approved, per origin, kept across restarts (ADR-0068): "this app may use this device" or
// "this site may use the device I picked". Read once, synchronously, into memory because the device permission
// handler is synchronous. Disposable: plain JSON under userData, tied to nothing but Node.
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { isPersistableOrigin, originFromUrl } from '../../broker/policy/origin.js'
import { deviceKey, type HidDeviceInfo } from './hid-policy.js'

export interface ApprovedDevice {
  readonly key: string
  readonly vendorId: number
  readonly productId: number
  readonly serialNumber?: string
  readonly name?: string
  readonly approvedAt: number
}

const FILE_VERSION = 1
const MAX_PER_ORIGIN = 256
const MAX_TEXT = 200

const isId = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffff
const isText = (value: unknown): value is string => typeof value === 'string' && value.length <= MAX_TEXT

function rowOf (device: HidDeviceInfo, approvedAt: number): ApprovedDevice {
  return {
    key: deviceKey(device),
    vendorId: device.vendorId,
    productId: device.productId,
    ...(device.serialNumber === undefined || device.serialNumber === '' ? {} : { serialNumber: device.serialNumber }),
    ...(device.name === undefined || device.name === '' ? {} : { name: device.name }),
    approvedAt
  }
}

/** The file is user-writable, so every row is untrusted: its key is recomputed, never read back. */
export function parseHidApprovals (raw: string): Map<string, ApprovedDevice[]> {
  const result = new Map<string, ApprovedDevice[]>()
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return result
  }
  if (typeof data !== 'object' || data === null) return result
  const { version, origins } = data as { version?: unknown, origins?: unknown }
  if (version !== FILE_VERSION || typeof origins !== 'object' || origins === null || Array.isArray(origins)) return result
  for (const [origin, rows] of Object.entries(origins)) {
    if (originFromUrl(origin) !== origin || !Array.isArray(rows)) continue
    const kept = new Map<string, ApprovedDevice>()
    for (const row of rows.slice(0, MAX_PER_ORIGIN) as unknown[]) {
      if (typeof row !== 'object' || row === null) continue
      const { vendorId, productId, serialNumber, name, approvedAt } = row as Record<string, unknown>
      if (!isId(vendorId) || !isId(productId)) continue
      if (serialNumber !== undefined && !isText(serialNumber)) continue
      if (name !== undefined && !isText(name)) continue
      const approved = rowOf({ vendorId, productId, serialNumber, name }, typeof approvedAt === 'number' && Number.isFinite(approvedAt) ? approvedAt : 0)
      kept.set(approved.key, approved)
    }
    if (kept.size > 0) result.set(origin, [...kept.values()])
  }
  return result
}

export class HidApprovals {
  readonly #path: string | null
  readonly #now: () => number
  #origins: Map<string, ApprovedDevice[]> | undefined
  readonly #listeners = new Set<(origin: string) => void>()

  /** A null path keeps the approvals in memory only, for a private session. */
  constructor (path: string | null, now: () => number = Date.now) {
    this.#path = path
    this.#now = now
  }

  has (origin: string, key: string): boolean {
    return this.#loaded().get(origin)?.some((device) => device.key === key) === true
  }

  list (origin: string): readonly ApprovedDevice[] {
    return this.#loaded().get(origin) ?? []
  }

  origins (): string[] {
    return [...this.#loaded().keys()]
  }

  approve (origin: string, device: HidDeviceInfo): void {
    const row = rowOf(device, this.#now())
    const rows = this.#loaded().get(origin) ?? []
    if (rows.some((existing) => existing.key === row.key) || rows.length >= MAX_PER_ORIGIN) return
    this.#loaded().set(origin, [...rows, row])
    this.#changed(origin)
  }

  forget (origin: string, key: string): boolean {
    const rows = this.#loaded().get(origin)
    if (rows === undefined || !rows.some((device) => device.key === key)) return false
    const rest = rows.filter((device) => device.key !== key)
    if (rest.length === 0) this.#loaded().delete(origin)
    else this.#loaded().set(origin, rest)
    this.#changed(origin)
    return true
  }

  forgetOrigin (origin: string): boolean {
    if (!this.#loaded().delete(origin)) return false
    this.#changed(origin)
    return true
  }

  /** Returns the removal. */
  onChange (listener: (origin: string) => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #changed (origin: string): void {
    this.#save()
    for (const listener of [...this.#listeners]) listener(origin)
  }

  #loaded (): Map<string, ApprovedDevice[]> {
    if (this.#origins === undefined) {
      let raw = ''
      try {
        if (this.#path !== null) raw = readFileSync(this.#path, 'utf8')
      } catch {
        // No file yet: nothing was approved.
      }
      this.#origins = parseHidApprovals(raw)
    }
    return this.#origins
  }

  /** Never throws: the approval already holds in memory for this session. A loopback or plain-http origin is not written (T13c). */
  #save (): void {
    if (this.#path === null) return
    const origins: Record<string, ApprovedDevice[]> = {}
    for (const [origin, rows] of this.#loaded()) if (isPersistableOrigin(origin)) origins[origin] = rows
    if (Object.keys(origins).length === 0 && !this.#everSaved()) return
    try {
      writeFileAtomic(this.#path, JSON.stringify({ version: FILE_VERSION, origins }, null, 2))
    } catch (error) {
      console.error('[hid] could not save approved devices:', error)
    }
  }

  #everSaved (): boolean {
    try {
      readFileSync(this.#path ?? '', 'utf8')
      return true
    } catch {
      return false
    }
  }
}
