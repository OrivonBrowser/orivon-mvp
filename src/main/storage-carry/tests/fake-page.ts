// A hidden page for the unit tests: the carry's script runs in it against the real IndexedDB rules of `fake-indexeddb`, each
// page with a factory of its own, as each session has its own storage.
import { webcrypto } from 'node:crypto'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { CarryPage } from '../carry-runner.js'
import { carryGlobalName, portMessageFor } from '../page-code.js'

export class FakeLocalStorage {
  private readonly items = new Map<string, string>()
  get length (): number { return this.items.size }
  key (index: number): string | null { return [...this.items.keys()][index] ?? null }
  getItem (name: string): string | null { return this.items.get(name) ?? null }
  setItem (name: string, value: string): void { this.items.set(name, value) }
  clear (): void { this.items.clear() }
}

export interface FakePage extends CarryPage {
  readonly indexedDB: IDBFactory
  readonly localStorage: FakeLocalStorage
  closed: boolean
  /** The nonce the shell opened the page with: the message that carries a port names it. */
  nonce: string
  /** The ports given to the page so far. */
  readonly given: unknown[]
  /** Defines a global before the script runs, as a page that got there first would. */
  predefine: (name: string, value: unknown) => void
}

/** A page whose script is installed for `nonce`, which the test passes to `carryPageCode` as well. */
export function fakePage (nonce = 'ab'.repeat(16)): FakePage {
  const listeners: Array<(event: { data: unknown, ports: unknown[] }) => void> = []
  const scope: Record<string, unknown> = {
    indexedDB: new IDBFactory(),
    IDBKeyRange,
    localStorage: new FakeLocalStorage(),
    crypto: webcrypto,
    CryptoKey: (globalThis as { CryptoKey?: unknown }).CryptoKey,
    Blob,
    File,
    addEventListener: (type: string, listener: (event: { data: unknown, ports: unknown[] }) => void) => { if (type === 'message') listeners.push(listener) }
  }
  scope['globalThis'] = scope
  const page = {
    nonce,
    closed: false,
    given: [] as unknown[],
    indexedDB: scope['indexedDB'] as IDBFactory,
    localStorage: scope['localStorage'] as FakeLocalStorage,
    predefine: (name: string, value: unknown) => { scope[name] = value },
    // Closing a page ends its connections and its port, as the page's death does.
    close: () => {
      page.closed = true
      const installed = scope[carryGlobalName(page.nonce)] as { closeAll?: () => void } | undefined
      installed?.closeAll?.()
    },
    give: async (port: unknown) => {
      page.given.push(port)
      for (const listener of listeners) listener({ data: portMessageFor(page.nonce), ports: [port] })
    },
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
