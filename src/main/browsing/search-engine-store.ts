// The engines a person can search by keyword: the built-in ones, which never change, and the site and custom
// engines kept in `search-engines.json`. The file holds only what a person may edit; the built-ins come from
// ./search-engines.ts and the starting site engines from ./site-engines.ts, merged in on load unless one was removed.
import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { writeFileAtomicAsync } from '../../broker/adapters/atomic-write.js'
import { DebouncedWriter } from '../storage/debounced-writer.js'
import { checkDraft, isKeywordText, MAX_ENGINES } from './search-engine-rules.js'
import type { EngineDraft, EngineField, EngineReason } from './search-engine-rules.js'
import { SEARCH_ENGINES, isValidSearchTemplate } from './search-engines.js'
import type { EngineView } from './search-resolve.js'
import { SEED_PREFIX, SITE_ENGINE_SEEDS } from './site-engines.js'

const FILE_VERSION = 1

interface StoredEngine {
  readonly id: string
  readonly name: string
  readonly keyword: string
  readonly template: string
}

export type StoreResult =
  | { readonly ok: true, readonly engine: EngineView }
  | { readonly ok: false, readonly field?: EngineField, readonly reason: EngineReason | 'limit' | 'private' | 'not-found' | 'builtin', readonly usedBy?: string }

export interface SearchEngineStoreOptions {
  /** A private session: the list is what the profile had, and nothing is written. */
  readonly readOnly?: boolean
  readonly newId?: () => string
}

const BUILT_IN: readonly EngineView[] = SEARCH_ENGINES.map((engine) => ({
  id: engine.id, name: engine.label, keyword: engine.keyword, template: engine.template, kind: 'builtin' as const
}))

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

export class SearchEngineStore {
  private engines: StoredEngine[] = SITE_ENGINE_SEEDS.map((seed) => ({ ...seed }))
  private removedSeeds = new Set<string>()
  private loading: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly writer = new DebouncedWriter(async () => { await this.writeNow() })
  private readonly readOnly: boolean
  private readonly newId: () => string

  constructor (private readonly filePath: string, options: SearchEngineStoreOptions = {}) {
    this.readOnly = options.readOnly === true
    this.newId = options.newId ?? (() => `e-${randomBytes(6).toString('hex')}`)
  }

  /** Reads the file once. A missing, unreadable or corrupt file leaves the starting site engines; an entry that
   * is not a valid engine, or whose keyword another engine already owns, is dropped. */
  load (): Promise<void> {
    this.loading ??= this.readFromDisk()
    return this.loading
  }

  private async readFromDisk (): Promise<void> {
    let parsed: unknown
    try {
      parsed = JSON.parse(await readFile(this.filePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[orivon] search engines file unreadable, using the starting list:', error)
      return
    }
    if (!isRecord(parsed) || parsed['version'] !== FILE_VERSION || !Array.isArray(parsed['engines'])) return
    const removed = new Set(Array.isArray(parsed['removedSeeds']) ? parsed['removedSeeds'].filter((id): id is string => typeof id === 'string') : [])
    const kept: StoredEngine[] = []
    const taken = new Set(BUILT_IN.map((engine) => engine.keyword.toLowerCase()))
    const ids = new Set(BUILT_IN.map((engine) => engine.id))
    for (const entry of parsed['engines'] as unknown[]) {
      const engine = readEngine(entry)
      if (engine === null || taken.has(engine.keyword.toLowerCase()) || ids.has(engine.id)) continue
      if (kept.length >= MAX_ENGINES) break
      taken.add(engine.keyword.toLowerCase())
      ids.add(engine.id)
      kept.push(engine)
    }
    // A starting engine this file does not know yet (added since it was written) joins, unless its keyword is taken.
    for (const seed of SITE_ENGINE_SEEDS) {
      if (removed.has(seed.id) || ids.has(seed.id) || taken.has(seed.keyword.toLowerCase())) continue
      taken.add(seed.keyword.toLowerCase())
      kept.push({ ...seed })
    }
    this.engines = kept
    this.removedSeeds = removed
  }

  /** The built-in engines, then the site and custom ones in the order the person keeps them. */
  all (): EngineView[] {
    return [...BUILT_IN, ...this.engines.map((engine) => ({ ...engine, kind: kindOf(engine.id) }))]
  }

  get (id: string): EngineView | undefined {
    return this.all().find((engine) => engine.id === id)
  }

  add (draft: EngineDraft): StoreResult {
    if (this.readOnly) return { ok: false, reason: 'private' }
    if (this.engines.length >= MAX_ENGINES) return { ok: false, reason: 'limit' }
    const check = checkDraft(draft, this.all())
    if (!check.ok) return check
    const engine: StoredEngine = { id: this.newId(), ...check.value }
    this.engines.push(engine)
    this.commit()
    return { ok: true, engine: { ...engine, kind: 'custom' } }
  }

  update (id: string, draft: EngineDraft): StoreResult {
    if (this.readOnly) return { ok: false, reason: 'private' }
    const at = this.engines.findIndex((engine) => engine.id === id)
    if (at === -1) return { ok: false, reason: BUILT_IN.some((engine) => engine.id === id) ? 'builtin' : 'not-found' }
    const check = checkDraft(draft, this.all().filter((engine) => engine.id !== id))
    if (!check.ok) return check
    const engine: StoredEngine = { id, ...check.value }
    this.engines[at] = engine
    this.commit()
    return { ok: true, engine: { ...engine, kind: kindOf(id) } }
  }

  remove (id: string): StoreResult {
    if (this.readOnly) return { ok: false, reason: 'private' }
    const at = this.engines.findIndex((engine) => engine.id === id)
    if (at === -1) return { ok: false, reason: BUILT_IN.some((engine) => engine.id === id) ? 'builtin' : 'not-found' }
    const [gone] = this.engines.splice(at, 1) as [StoredEngine]
    if (id.startsWith(SEED_PREFIX)) this.removedSeeds.add(id)
    this.commit()
    return { ok: true, engine: { ...gone, kind: kindOf(id) } }
  }

  onChange (listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Resolves once the file reflects every change made so far. */
  async flush (): Promise<void> {
    await this.writer.flush()
  }

  private commit (): void {
    for (const listener of this.listeners) listener()
    this.writer.schedule()
  }

  private async writeNow (): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      await writeFileAtomicAsync(this.filePath, JSON.stringify({ version: FILE_VERSION, engines: this.engines, removedSeeds: [...this.removedSeeds] }, null, 2))
    } catch (error) {
      console.error('[orivon] failed to persist search engines:', error)
      throw error
    }
  }
}

const kindOf = (id: string): 'site' | 'custom' => id.startsWith(SEED_PREFIX) ? 'site' : 'custom'

/** One file entry, or null when any part is not what this store would have written. */
function readEngine (entry: unknown): StoredEngine | null {
  if (!isRecord(entry)) return null
  const { id, name, keyword, template } = entry
  if (typeof id !== 'string' || id === '' || id.length > 64 || typeof name !== 'string' || name.trim() === '' || name.length > 60) return null
  if (typeof keyword !== 'string' || keyword.length > 20 || !isKeywordText(keyword)) return null
  if (typeof template !== 'string' || !isValidSearchTemplate(template)) return null
  return { id, name, keyword, template }
}
