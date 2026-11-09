// The script the shell runs in the two hidden pages the storage carry opens (`carry-session.ts`): one in the session the
// app used to run in, which reads, and one in the session websites run in, which writes. It is a string of plain
// JavaScript, not a function of this file, because a bundler is free to rename and wrap a function that
// `toString()` would then hand to a page; `tests/page-code.test.ts` runs the very same text against a fake
// IndexedDB. See README.md's Design notes for what is carried and how a value is encoded.
//
// Every entry point returns a JSON string. `executeJavaScript` would convert an object or a buffer on its own and
// stop at the first value it cannot (a Blob, a Date inside a Map); a string is the one result it never changes.

export const CARRY_PAGE_CODE = String.raw`(function () {
  'use strict'
  var root = globalThis
  if (root.__orivonCarry !== undefined) return 'ready'

  var MAX_VALUE_BYTES = 96 * 1024 * 1024
  var BATCH_WEIGHT = 1536 * 1024
  var BATCH_RECORDS = 200
  var TYPED = { Int8Array: Int8Array, Uint8Array: Uint8Array, Uint8ClampedArray: Uint8ClampedArray, Int16Array: Int16Array, Uint16Array: Uint16Array, Int32Array: Int32Array, Uint32Array: Uint32Array, Float32Array: Float32Array, Float64Array: Float64Array, BigInt64Array: BigInt64Array, BigUint64Array: BigUint64Array }
  var ERRORS = { Error: Error, EvalError: EvalError, RangeError: RangeError, ReferenceError: ReferenceError, SyntaxError: SyntaxError, TypeError: TypeError, URIError: URIError }

  function toBase64 (bytesLike) {
    var bytes = bytesLike instanceof Uint8Array ? bytesLike : new Uint8Array(bytesLike)
    var out = ''
    for (var i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
    return btoa(out)
  }

  function fromBase64 (text) {
    var raw = atob(text)
    var bytes = new Uint8Array(raw.length)
    for (var i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
    return bytes
  }

  function messageOf (error) {
    return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
  }

  function tooLarge (bytes) {
    if (bytes > MAX_VALUE_BYTES) throw new Error('a value of ' + bytes + ' bytes is too large to carry')
  }

  function algorithmOf (algorithm) {
    var out = { name: algorithm.name }
    if (typeof algorithm.namedCurve === 'string') out.namedCurve = algorithm.namedCurve
    if (algorithm.hash !== undefined) out.hash = typeof algorithm.hash === 'string' ? algorithm.hash : algorithm.hash.name
    return out
  }

  /** A structured-clone value as JSON. A key named $t is the mark of a tagged value, so a plain object that has one is wrapped. */
  async function encode (value, ancestors) {
    if (value === null) return null
    var kind = typeof value
    if (kind === 'string' || kind === 'boolean') return value
    if (kind === 'number') {
      if (Number.isFinite(value) && !Object.is(value, -0)) return value
      return { $t: 'num', v: Object.is(value, -0) ? '-0' : String(value) }
    }
    if (kind === 'undefined') return { $t: 'undef' }
    if (kind === 'bigint') return { $t: 'bigint', v: value.toString() }
    if (kind !== 'object') throw new Error('a ' + kind + ' cannot be stored')
    if (ancestors.has(value)) throw new Error('a value that contains itself')
    if (value instanceof Date) return { $t: 'date', v: Number.isNaN(value.getTime()) ? null : value.getTime() }
    if (value instanceof RegExp) return { $t: 'regexp', source: value.source, flags: value.flags }
    if (value instanceof ArrayBuffer) {
      tooLarge(value.byteLength)
      return { $t: 'buffer', b: toBase64(value) }
    }
    if (ArrayBuffer.isView(value)) {
      var viewName = value instanceof DataView ? 'DataView' : value.constructor.name
      if (viewName !== 'DataView' && !Object.prototype.hasOwnProperty.call(TYPED, viewName)) throw new Error('an unsupported ' + viewName)
      tooLarge(value.byteLength)
      return { $t: 'view', ctor: viewName, b: toBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      tooLarge(value.size)
      var data = toBase64(await value.arrayBuffer())
      if (typeof File !== 'undefined' && value instanceof File) return { $t: 'file', name: value.name, type: value.type, modified: value.lastModified, b: data }
      return { $t: 'blob', type: value.type, b: data }
    }
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) {
      if (!value.extractable) throw new Error('a key that is not extractable cannot be read')
      return { $t: 'key', jwk: await root.crypto.subtle.exportKey('jwk', value), algorithm: algorithmOf(value.algorithm), usages: Array.from(value.usages) }
    }
    ancestors.add(value)
    try {
      if (value instanceof Map) {
        var entries = []
        for (var pair of value) entries.push([await encode(pair[0], ancestors), await encode(pair[1], ancestors)])
        return { $t: 'map', e: entries }
      }
      if (value instanceof Set) {
        var members = []
        for (var member of value) members.push(await encode(member, ancestors))
        return { $t: 'set', v: members }
      }
      if (Array.isArray(value)) {
        var items = new Array(value.length)
        for (var i = 0; i < value.length; i++) items[i] = await encode(value[i], ancestors)
        return items
      }
      if (value instanceof Error) return { $t: 'error', name: value.name, message: value.message }
      var proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) throw new Error('an unsupported ' + Object.prototype.toString.call(value))
      var out = Object.create(null)
      var names = Object.keys(value)
      for (var j = 0; j < names.length; j++) out[names[j]] = await encode(value[names[j]], ancestors)
      return Object.prototype.hasOwnProperty.call(out, '$t') ? { $t: 'object', v: out } : out
    } finally {
      ancestors.delete(value)
    }
  }

  function define (target, name, value) {
    Object.defineProperty(target, name, { value: value, enumerable: true, writable: true, configurable: true })
  }

  async function decodeProperties (node) {
    var out = {}
    var names = Object.keys(node)
    for (var i = 0; i < names.length; i++) define(out, names[i], await decode(node[names[i]]))
    return out
  }

  /** The inverse of encode. */
  async function decode (node) {
    if (node === null || typeof node !== 'object') return node
    if (Array.isArray(node)) {
      var items = new Array(node.length)
      for (var i = 0; i < node.length; i++) items[i] = await decode(node[i])
      return items
    }
    switch (node.$t) {
      case undefined: return await decodeProperties(node)
      case 'object': return await decodeProperties(node.v)
      case 'num': return node.v === '-0' ? -0 : Number(node.v)
      case 'undef': return undefined
      case 'bigint': return BigInt(node.v)
      case 'date': return new Date(node.v === null ? NaN : node.v)
      case 'regexp': return new RegExp(node.source, node.flags)
      case 'buffer': return fromBase64(node.b).buffer
      case 'view': {
        var bytes = fromBase64(node.b)
        return node.ctor === 'DataView' ? new DataView(bytes.buffer) : new TYPED[node.ctor](bytes.buffer)
      }
      case 'blob': return new Blob([fromBase64(node.b)], { type: node.type })
      case 'file': return new File([fromBase64(node.b)], node.name, { type: node.type, lastModified: node.modified })
      case 'key': return await root.crypto.subtle.importKey('jwk', node.jwk, node.algorithm, true, node.usages)
      case 'map': {
        var map = new Map()
        for (var e = 0; e < node.e.length; e++) map.set(await decode(node.e[e][0]), await decode(node.e[e][1]))
        return map
      }
      case 'set': {
        var set = new Set()
        for (var m = 0; m < node.v.length; m++) set.add(await decode(node.v[m]))
        return set
      }
      case 'error': {
        var Kind = Object.prototype.hasOwnProperty.call(ERRORS, node.name) ? ERRORS[node.name] : Error
        return new Kind(node.message)
      }
      default: throw new Error('an unknown kind of value: ' + String(node.$t))
    }
  }

  /** About how many bytes a value's JSON will take: enough to cut a batch, not a measurement. */
  function weigh (value, depth) {
    if (value === null || value === undefined) return 4
    if (typeof value === 'string') return value.length
    if (typeof value !== 'object') return 16
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
    if (depth > 6) return 64
    var total = 16
    var members = value instanceof Map || value instanceof Set ? Array.from(value).slice(0, 2000) : Array.isArray(value) ? value.slice(0, 2000) : Object.values(value).slice(0, 2000)
    for (var i = 0; i < members.length; i++) total += 8 + weigh(Array.isArray(members[i]) && (value instanceof Map) ? members[i][1] : members[i], depth + 1)
    return total
  }

  function request (req) {
    return new Promise(function (resolve, reject) {
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error) }
    })
  }

  var reading = new Map()
  var writing = new Map()

  function openExisting (name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(name)
      req.onupgradeneeded = function () {
        req.transaction.abort()
        reject(new Error('the database is gone'))
      }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { reject(req.error) }
      req.onblocked = function () { reject(new Error('the database is blocked')) }
    })
  }

  async function connection (name) {
    var kept = reading.get(name)
    if (kept !== undefined) return kept
    var opened = await openExisting(name)
    reading.set(name, opened)
    return opened
  }

  async function storeShape (db, storeName) {
    var tx = db.transaction(storeName, 'readonly')
    var store = tx.objectStore(storeName)
    var indexes = Array.from(store.indexNames).map(function (indexName) {
      var index = store.index(indexName)
      return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry }
    })
    return { name: storeName, keyPath: store.keyPath, autoIncrement: store.autoIncrement, indexes: indexes, count: await request(store.count()) }
  }

  async function readDatabases () {
    var listed = await indexedDB.databases()
    var out = []
    for (var i = 0; i < listed.length; i++) {
      var name = listed[i].name
      if (typeof name !== 'string') continue
      try {
        var db = await connection(name)
        var stores = []
        var storeNames = Array.from(db.objectStoreNames)
        for (var s = 0; s < storeNames.length; s++) stores.push(await storeShape(db, storeNames[s]))
        out.push({ name: name, version: db.version, stores: stores })
      } catch (error) {
        out.push({ name: name, version: 0, stores: [], error: messageOf(error) })
      }
    }
    return JSON.stringify(out)
  }

  async function readBatch (args) {
    var db = await connection(args.db)
    var after = args.after === undefined ? undefined : await decode(args.after)
    var range = after === undefined ? undefined : IDBKeyRange.lowerBound(after, true)
    var rows = []
    var weight = 0
    var done = true
    await new Promise(function (resolve, reject) {
      var req = db.transaction(args.store, 'readonly').objectStore(args.store).openCursor(range)
      req.onerror = function () { reject(req.error) }
      req.onsuccess = function () {
        var cursor = req.result
        if (cursor === null) { resolve(); return }
        rows.push({ key: cursor.primaryKey, value: cursor.value })
        weight += weigh(cursor.value, 0)
        if (weight >= BATCH_WEIGHT || rows.length >= BATCH_RECORDS) { done = false; resolve(); return }
        cursor.continue()
      }
    })
    var records = []
    var problems = []
    for (var i = 0; i < rows.length; i++) {
      try {
        records.push({ k: await encode(rows[i].key, new Set()), v: await encode(rows[i].value, new Set()) })
      } catch (error) {
        problems.push('record ' + (args.offset + i + 1) + ': ' + messageOf(error))
      }
    }
    var last = rows.length === 0 ? undefined : await encode(rows[rows.length - 1].key, new Set())
    return JSON.stringify({ records: records, read: rows.length, next: last, done: done, problems: problems })
  }

  async function writeSchema(spec) {
    var existing = (await indexedDB.databases()).some(function (info) { return info.name === spec.name })
    if (existing) return JSON.stringify({ status: 'exists' })
    try {
      var opened = await new Promise(function (resolve, reject) {
        var req = indexedDB.open(spec.name, spec.version)
        req.onupgradeneeded = function () {
          for (var i = 0; i < spec.stores.length; i++) {
            var shape = spec.stores[i]
            var store = req.result.createObjectStore(shape.name, { keyPath: shape.keyPath, autoIncrement: shape.autoIncrement })
            for (var j = 0; j < shape.indexes.length; j++) {
              var index = shape.indexes[j]
              store.createIndex(index.name, index.keyPath, { unique: index.unique, multiEntry: index.multiEntry })
            }
          }
        }
        req.onsuccess = function () { resolve(req.result) }
        req.onerror = function () { reject(req.error) }
        req.onblocked = function () { reject(new Error('the database is blocked')) }
      })
      writing.set(spec.name, opened)
      return JSON.stringify({ status: 'created' })
    } catch (error) {
      return JSON.stringify({ status: 'failed', reason: messageOf(error) })
    }
  }

  async function writeBatch (args) {
    var db = writing.get(args.db)
    if (db === undefined) throw new Error('the database was not made by the carry')
    var problems = []
    var ready = []
    for (var i = 0; i < args.records.length; i++) {
      try {
        ready.push({ key: await decode(args.records[i].k), value: await decode(args.records[i].v), position: args.offset + i + 1 })
      } catch (error) {
        problems.push('record ' + (args.offset + i + 1) + ': ' + messageOf(error))
      }
    }
    var written = 0
    await new Promise(function (resolve) {
      var tx = db.transaction(args.store, 'readwrite')
      var store = tx.objectStore(args.store)
      tx.oncomplete = function () { resolve() }
      tx.onabort = function () { problems.push('the batch was not stored: ' + messageOf(tx.error)); resolve() }
      ready.forEach(function (row) {
        try {
          var req = store.keyPath === null ? store.put(row.value, row.key) : store.put(row.value)
          req.onsuccess = function () { written += 1 }
          req.onerror = function (event) {
            event.preventDefault()
            event.stopPropagation()
            problems.push('record ' + row.position + ': ' + messageOf(req.error))
          }
        } catch (error) {
          problems.push('record ' + row.position + ': ' + messageOf(error))
        }
      })
      if (ready.length === 0) resolve()
    })
    return JSON.stringify({ written: written, problems: problems })
  }

  async function dropDatabase (name) {
    var kept = writing.get(name)
    if (kept !== undefined) kept.close()
    writing.delete(name)
    await new Promise(function (resolve) {
      var req = indexedDB.deleteDatabase(name)
      req.onsuccess = req.onerror = req.onblocked = function () { resolve() }
    })
    return 'dropped'
  }

  function closeAll () {
    reading.forEach(function (db) { db.close() })
    writing.forEach(function (db) { db.close() })
    reading.clear()
    writing.clear()
    return 'closed'
  }

  function readLocalStorage () {
    var entries = []
    for (var i = 0; i < localStorage.length; i++) {
      var name = localStorage.key(i)
      entries.push([name, localStorage.getItem(name)])
    }
    return JSON.stringify(entries)
  }

  function writeLocalStorage (entries) {
    var carried = 0
    var skipped = 0
    var problems = []
    entries.forEach(function (entry) {
      try {
        if (localStorage.getItem(entry[0]) !== null) { skipped += 1; return }
        localStorage.setItem(entry[0], entry[1])
        carried += 1
      } catch (error) {
        problems.push('item ' + (carried + skipped + problems.length + 1) + ': ' + messageOf(error))
      }
    })
    return JSON.stringify({ carried: carried, skipped: skipped, problems: problems })
  }

  root.__orivonCarry = { readDatabases: readDatabases, readBatch: readBatch, writeSchema: writeSchema, writeBatch: writeBatch, dropDatabase: dropDatabase, closeAll: closeAll, readLocalStorage: readLocalStorage, writeLocalStorage: writeLocalStorage, encode: encode, decode: decode }
  return 'ready'
})()`
