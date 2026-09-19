// FreeTube's datastores are `@seald-io/nedb` collections, and nedb's on-disk
// format is append-only NDJSON: one JSON document per line, a later line with
// the same `_id` superseding an earlier one, and `{$$deleted:true}` marking a
// removal. This reimplements that format over `orivon.fs` rather than a
// format of our own, so a collection written here stays readable by the real
// nedb a full port would eventually load it with.
//
// Compaction rewrites the whole file, so it is the only operation whose cost
// grows with history; it runs on a write count, never on every write.

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const COMPACT_AFTER_WRITES = 200

function parseLines (text) {
  const documents = new Map()
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(line)
    } catch {
      // nedb itself tolerates a torn trailing line from an interrupted
      // write by dropping it; matching that keeps a half-written file
      // loadable instead of throwing the app out on startup.
      continue
    }
    const id = parsed?._id
    if (typeof id !== 'string') continue
    if (parsed.$$deleted === true) documents.delete(id)
    else documents.set(id, parsed)
  }
  return documents
}

function serialise (documents) {
  let out = ''
  for (const document of documents.values()) out += JSON.stringify(document) + '\n'
  return out
}

function matches (document, query) {
  for (const [key, expected] of Object.entries(query)) {
    if (document[key] !== expected) return false
  }
  return true
}

function newId () {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Backed by `orivon.fs` when the app holds an `fs` grant, and by memory
 * when it does not. A refused filesystem grant costs history and settings
 * their persistence, never the app's ability to run -- the manifest asks
 * for per-capability consent, so this state is reachable on purpose.
 */
export class Collection {
  constructor (name, fs) {
    this.name = name
    this.path = `${name}.db`
    this.fs = fs
    this.documents = new Map()
    this.writesSinceCompaction = 0
    this.loaded = false
  }

  get persistent () {
    return this.fs !== undefined
  }

  async load () {
    if (this.loaded) return
    this.loaded = true
    if (this.fs === undefined) return
    try {
      const bytes = await this.fs.readFile(this.path)
      this.documents = parseLines(decoder.decode(bytes))
    } catch {
      // A collection that has never been written has no file yet. Every
      // other read failure is equally non-fatal here: an unreadable
      // collection starts empty rather than blocking startup.
      this.documents = new Map()
    }
  }

  async append (record) {
    if (this.fs === undefined) return
    this.writesSinceCompaction += 1
    if (this.writesSinceCompaction >= COMPACT_AFTER_WRITES) {
      await this.compact()
      return
    }
    let existing = ''
    try {
      existing = decoder.decode(await this.fs.readFile(this.path))
    } catch {
      existing = ''
    }
    await this.fs.writeFile(this.path, encoder.encode(existing + JSON.stringify(record) + '\n'))
  }

  async compact () {
    if (this.fs === undefined) return
    this.writesSinceCompaction = 0
    await this.fs.writeFile(this.path, encoder.encode(serialise(this.documents)))
  }

  async find (query = {}) {
    await this.load()
    const found = []
    for (const document of this.documents.values()) {
      if (matches(document, query)) found.push(document)
    }
    return found
  }

  async findOne (query = {}) {
    return (await this.find(query))[0]
  }

  async insert (document) {
    await this.load()
    const record = { ...document, _id: document._id ?? newId() }
    this.documents.set(record._id, record)
    await this.append(record)
    return record
  }

  /** Insert-or-replace on `_id`, which is how every FreeTube settings write behaves. */
  async upsert (document) {
    await this.load()
    if (typeof document._id !== 'string') return await this.insert(document)
    this.documents.set(document._id, document)
    await this.append(document)
    return document
  }

  async remove (query = {}) {
    await this.load()
    const doomed = await this.find(query)
    for (const document of doomed) {
      this.documents.delete(document._id)
      await this.append({ _id: document._id, $$deleted: true })
    }
    return doomed.length
  }

  async clear () {
    await this.load()
    this.documents = new Map()
    await this.compact()
  }
}

/**
 * The collections FreeTube's preload bridge exposes as its `DB_*` channels.
 * Named here rather than created on demand so the settings screen can report
 * what is persisted without first triggering a write.
 */
export const COLLECTION_NAMES = ['settings', 'history', 'playlists', 'profiles', 'searchHistory', 'subscriptionCache']

export function openCollections (fs) {
  const collections = {}
  for (const name of COLLECTION_NAMES) collections[name] = new Collection(name, fs)
  return collections
}
