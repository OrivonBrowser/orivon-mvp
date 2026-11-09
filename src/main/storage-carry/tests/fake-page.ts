// A hidden page for the unit tests: the carry's script runs in it against the real IndexedDB rules of `fake-indexeddb`, each
// page with a factory of its own, as each session has its own storage.
import { webcrypto } from 'node:crypto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { CarryPage } from '../carry-runner.js'

export class FakeLocalStorage {
  private readonly items = new Map<string, string>()
  get length (): number { return this.items.size }
  key (index: number): string | null { return [...this.items.keys()][index] ?? null }
  getItem (name: string): string | null { return this.items.get(name) ?? null }
  setItem (name: string, value: string): void { this.items.set(name, value) }
}

export interface Codec {
  encode: (value: unknown, ancestors: Set<unknown>) => Promise<unknown>
  decode: (node: unknown) => Promise<unknown>
}

export interface FakePage extends CarryPage {
  readonly indexedDB: IDBFactory
  readonly localStorage: FakeLocalStorage
  /** The script's own encoder and decoder, once the script has run in the page. */
  readonly codec: Codec
  closed: boolean
}

export function fakePage (): FakePage {
  const scope: Record<string, unknown> = {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    localStorage: new FakeLocalStorage(),
    crypto: webcrypto,
    CryptoKey: (globalThis as { CryptoKey?: unknown }).CryptoKey,
    Blob,
    File,
    btoa,
    atob
  }
  scope['globalThis'] = scope
  const page = {
    closed: false,
    indexedDB: scope['indexedDB'] as IDBFactory,
    localStorage: scope['localStorage'] as FakeLocalStorage,
    get codec (): Codec { return scope['__orivonCarry'] as Codec },
    close: () => { page.closed = true },
    run: async (code: string): Promise<string> => {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
      const evaluate = new Function('scope', `with (scope) { return (${code}) }`) as (scope: Record<string, unknown>) => unknown
      return await evaluate(scope) as string
    }
  }
  return page
}

/** Runs `use` with the connection to database `name` of `factory`, and closes it. */
export async function withDatabase<T> (factory: IDBFactory, name: string, use: (db: IDBDatabase) => Promise<T>, upgrade?: (db: IDBDatabase) => void, version?: number): Promise<T> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = version === undefined ? factory.open(name) : factory.open(name, version)
    if (upgrade !== undefined) request.onupgradeneeded = () => { upgrade(request.result) }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('open failed')) }
  })
  try {
    return await use(db)
  } finally {
    db.close()
  }
}

export async function putAll (db: IDBDatabase, store: string, rows: ReadonlyArray<readonly [unknown, IDBValidKey | undefined]>): Promise<void> {
  const tx = db.transaction(store, 'readwrite')
  for (const [value, key] of rows) {
    if (key === undefined) tx.objectStore(store).put(value)
    else tx.objectStore(store).put(value, key)
  }
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => { resolve() }; tx.onerror = () => { reject(tx.error ?? new Error('put failed')) } })
}

export async function readAll (db: IDBDatabase, store: string): Promise<Array<{ key: IDBValidKey, value: unknown }>> {
  return await new Promise((resolve, reject) => {
    const out: Array<{ key: IDBValidKey, value: unknown }> = []
    const request = db.transaction(store, 'readonly').objectStore(store).openCursor()
    request.onerror = () => { reject(request.error ?? new Error('read failed')) }
    request.onsuccess = () => {
      const cursor = request.result
      if (cursor === null) { resolve(out); return }
      out.push({ key: cursor.primaryKey, value: cursor.value })
      cursor.continue()
    }
  })
}
