// What the person told each site, per kind of thing it may do: a site's
// camera is allowed, its location blocked. One file, `site-settings.json`,
// read once and synchronously, because the permission gate's check handler
// cannot wait on disk. Built over a path, or over `null` for a private
// session, which keeps every answer in memory and never writes a file.
import { readFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '../../broker/adapters/atomic-write.js'
import { originFromUrl } from '../../broker/policy/origin.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { siteKindById, type SiteKind } from './kinds.js'

/** A stored answer. "Ask" is the absence of one. */
export type SiteDecision = 'allow' | 'block'

export interface SiteSettingEntry { origin: string, kind: SiteKind, value: SiteDecision }

/** The most origins remembered; past it the one written longest ago is forgotten. */
export const MAX_SITE_ORIGINS = 5000

const FILE_VERSION = 1

const isDecision = (value: unknown): value is SiteDecision => value === 'allow' || value === 'block'

/** `origin` is the site that changed, or null when many did. */
export type SiteSettingsListener = (origin: string | null) => void

export class SiteSettingsStore {
  /** Insertion order is write order, so the first key is the one written longest ago. */
  private readonly sites = new Map<string, Map<SiteKind, SiteDecision>>()
  private readonly listeners = new Set<SiteSettingsListener>()
  private readonly writer: DebouncedWriter | null
  private loaded = false

  constructor (private readonly filePath: string | null) {
    this.writer = filePath === null ? null : new DebouncedWriter(async () => { this.writeNow() })
  }

  get persistent (): boolean {
    return this.filePath !== null
  }

  /** The answer for one kind, or undefined when the site was never asked or was told to ask again. */
  get (origin: string, kind: SiteKind): SiteDecision | undefined {
    this.load()
    return this.sites.get(origin)?.get(kind)
  }

  /** Every stored answer for a site. */
  forOrigin (origin: string): ReadonlyMap<SiteKind, SiteDecision> {
    this.load()
    return this.sites.get(origin) ?? new Map()
  }

  set (origin: string, kind: SiteKind, value: SiteDecision): void {
    this.load()
    if (originFromUrl(origin) !== origin || siteKindById(kind) === undefined || !isDecision(value)) return
    const kinds = this.sites.get(origin) ?? new Map<SiteKind, SiteDecision>()
    if (kinds.get(kind) === value) return
    kinds.set(kind, value)
    // Re-inserted, so the map's order is the order of the last write.
    this.sites.delete(origin)
    this.sites.set(origin, kinds)
    this.trim()
    this.changed(origin)
  }

  /** Back to "ask": the site's next request prompts again. */
  forget (origin: string, kind: SiteKind): void {
    this.load()
    const kinds = this.sites.get(origin)
    if (kinds === undefined || !kinds.delete(kind)) return
    if (kinds.size === 0) this.sites.delete(origin)
    this.changed(origin)
  }

  /** Forgets every answer for one site. */
  forgetOrigin (origin: string): void {
    this.load()
    if (this.sites.delete(origin)) this.changed(origin)
  }

  clear (): void {
    this.load()
    if (this.sites.size === 0) return
    this.sites.clear()
    this.changed(null)
  }

  entries (): SiteSettingEntry[] {
    this.load()
    return [...this.sites].flatMap(([origin, kinds]) => [...kinds].map(([kind, value]) => ({ origin, kind, value })))
  }

  /** Whether any site is stored as blocked for `kind`. */
  hasBlock (kind: SiteKind): boolean {
    this.load()
    for (const kinds of this.sites.values()) if (kinds.get(kind) === 'block') return true
    return false
  }

  get size (): number {
    this.load()
    return this.sites.size
  }

  /** Returns the removal. */
  onChange (listener: SiteSettingsListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  async flush (): Promise<void> {
    await this.writer?.flush()
  }

  /** Reads the file on first use. A file that is missing, corrupt or of another version starts the store empty, and an entry whose origin, kind or value is not one this build would itself have written is dropped: the file is the person's to edit. */
  private load (): void {
    if (this.loaded) return
    this.loaded = true
    if (this.filePath === null) return
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] site settings unreadable, starting with none:', error)
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== FILE_VERSION) return
    const stored = (parsed as { sites?: unknown }).sites
    if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return
    for (const [origin, kinds] of Object.entries(stored)) {
      if (originFromUrl(origin) !== origin || typeof kinds !== 'object' || kinds === null || Array.isArray(kinds)) continue
      const kept = new Map<SiteKind, SiteDecision>()
      for (const [kind, value] of Object.entries(kinds)) {
        const def = siteKindById(kind)
        if (def !== undefined && isDecision(value)) kept.set(def.id, value)
      }
      if (kept.size > 0) this.sites.set(origin, kept)
    }
    this.trim()
  }

  private trim (): void {
    for (const origin of this.sites.keys()) {
      if (this.sites.size <= MAX_SITE_ORIGINS) break
      this.sites.delete(origin)
    }
  }

  private changed (origin: string | null): void {
    this.writer?.schedule()
    for (const listener of [...this.listeners]) listener(origin)
  }

  private writeNow (): void {
    if (this.filePath === null) return
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      const sites = Object.fromEntries([...this.sites].map(([origin, kinds]) => [origin, Object.fromEntries(kinds)]))
      writeFileAtomic(this.filePath, JSON.stringify({ version: FILE_VERSION, sites }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist site settings:', error)
      throw error
    }
  }
}
