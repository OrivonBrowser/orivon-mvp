// The script the shell runs in the two hidden pages the storage carry opens (`carry-pages.ts`): one in the session the app
// used to run in, which reads, and one in the session websites run in, which writes. It is a string of plain JavaScript, not a
// function of this file, because a bundler is free to rename and wrap a function that `toString()` would then hand to a page;
// `tests/page-code.test.ts` runs the very same text against a fake IndexedDB. See README.md's Design notes for what is carried.
//
// Records travel from the reading page to the writing page over a message port, by structured clone, so keys, dates, binary
// data, maps, sets, shared objects and cycles arrive as they were. Every entry point returns a JSON string, because
// `executeJavaScript` would convert an object on its own and stop at the first value it cannot.

import { STORAGE_CARRY_PORT_MESSAGE } from '../channels.js'

/** What the preload posts to the page, with the port, so that only a page that holds this carry's nonce takes it. */
export function portMessageFor (nonce: string): string {
  return `${STORAGE_CARRY_PORT_MESSAGE}${nonce}`
}

/** The name the script installs itself under: it ends in the nonce, which no page can have defined. */
export function carryGlobalName (nonce: string): string {
  return `__orivonCarry${nonce}`
}

/** The script text that calls `method` of the installed script, its arguments passed as one string literal that `JSON.parse` reads: a key named `__proto__` in them is data, never a prototype. */
export function callCode (nonce: string, method: string, args?: unknown): string {
  return `${carryGlobalName(nonce)}.${method}(${args === undefined ? '' : `JSON.parse(${JSON.stringify(JSON.stringify(args))})`})`
}

export function carryPageCode (nonce: string): string {
  return CARRY_PAGE_CODE.replace('__NONCE__', () => JSON.stringify(nonce)).replace('__PORT_MESSAGE_PREFIX__', () => JSON.stringify(STORAGE_CARRY_PORT_MESSAGE))
}

const CARRY_PAGE_CODE = String.raw`(function (nonce) {
  'use strict'
  var root = globalThis
  var NAME = '__orivonCarry' + nonce
  if (root[NAME] !== undefined) return 'taken'

  var MAX_VALUE_BYTES = 96 * 1024 * 1024
  var BATCH_WEIGHT = 1536 * 1024
  var BATCH_RECORDS = 200
  var PORT_WAIT_MS = 30000
  var BATCH_WAIT_MS = 100000
  var PORT_MESSAGE = __PORT_MESSAGE_PREFIX__ + nonce

  function messageOf (error) {
    return error !== null && typeof error === 'object' && typeof error.message === 'string' ? error.message : String(error)
  }

  var port = null
  var portWaiters = []
  var inbox = new Map()
  var inboxWaiters = new Map()

  root.addEventListener('message', function (event) {
    if (event.data !== PORT_MESSAGE || port !== null || !event.ports || event.ports.length === 0) return
    port = event.ports[0]
    port.onmessage = function (message) {
      var data = message.data
      var waiter = inboxWaiters.get(data.id)
      if (waiter !== undefined) {
        inboxWaiters.delete(data.id)
        waiter(data)
      } else {
        inbox.set(data.id, data)
      }
    }
    portWaiters.splice(0).forEach(function (resolve) { resolve() })
  })

  function connect () {
    if (port !== null) return Promise.resolve('connected')
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error('the port to the other page never came')) }, PORT_WAIT_MS)
      portWaiters.push(function () { clearTimeout(timer); resolve('connected') })
    })
  }

  function takeBatch (id) {
    if (inbox.has(id)) {
      var kept = inbox.get(id)
      inbox.delete(id)
      return Promise.resolve(kept)
    }
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { inboxWaiters.delete(id); reject(new Error('the batch never came from the other page')) }, BATCH_WAIT_MS)
      inboxWaiters.set(id, function (data) { clearTimeout(timer); resolve(data) })
    })
  }

  /** About how many bytes a value takes: enough to cut a batch, not a measurement. Cycles and shared objects count once. */
  function weigh (value, seen) {
    if (value === null || value === undefined) return 4
    if (typeof value === 'string') return value.length
    if (typeof value !== 'object') return 16
    if (typeof Blob !== 'undefined' && value instanceof Blob) return value.size
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value.byteLength
    if (seen.has(value)) return 0
    seen.add(value)
    var total = 16
    var members = value instanceof Map ? Array.from(value).flat() : value instanceof Set ? Array.from(value) : Array.isArray(value) ? value : Object.values(value)
    for (var i = 0; i < members.length && i < 5000; i++) total += 8 + weigh(members[i], seen)
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
  var cursors = new Map()

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

  /** Reads the next batch of a store and posts it over the port: the keys and values never pass through the shell. */
  async function sendBatch (args) {
    if (port === null) throw new Error('the reading page has no port')
    var db = await connection(args.db)
    var cursorId = args.db + '\u0000' + args.store
    if (args.restart === true) cursors.delete(cursorId)
    var state = cursors.get(cursorId) || { has: false, key: undefined }
    var range = state.has ? IDBKeyRange.lowerBound(state.key, true) : undefined
    var rows = []
    var weights = []
    var weight = 0
    var done = true
    await new Promise(function (resolve, reject) {
      var req = db.transaction(args.store, 'readonly').objectStore(args.store).openCursor(range)
      req.onerror = function () { reject(req.error) }
      req.onsuccess = function () {
        var cursor = req.result
        if (cursor === null) { resolve(); return }
        rows.push({ key: cursor.primaryKey, value: cursor.value })
        var own = weigh(cursor.value, new Set())
        weights.push(own)
        weight += own
        if (weight >= BATCH_WEIGHT || rows.length >= BATCH_RECORDS) { done = false; resolve(); return }
        cursor.continue()
      }
    })
    if (rows.length > 0) {
      state.has = true
      state.key = rows[rows.length - 1].key
    }
    cursors.set(cursorId, state)
    var skipped = []
    var sendable = []
    rows.forEach(function (row, i) {
      if (weights[i] > MAX_VALUE_BYTES) skipped.push('record ' + (args.offset + i + 1) + ': a value of ' + weights[i] + ' bytes is too large to carry')
      else sendable.push({ row: row, position: args.offset + i + 1 })
    })
    var records = sendable.map(function (entry) { return entry.row })
    try {
      port.postMessage({ id: args.id, records: records })
    } catch (error) {
      // One record cannot be cloned (a handle, say): find which, and send the rest.
      var good = []
      sendable.forEach(function (entry) {
        try {
          structuredClone(entry.row)
          good.push(entry.row)
        } catch (cloneError) {
          skipped.push('record ' + entry.position + ': ' + messageOf(cloneError))
        }
      })
      port.postMessage({ id: args.id, records: good })
    }
    return JSON.stringify({ read: rows.length, done: done, skipped: skipped })
  }

  /** The value with every Blob and File in it rebuilt from its bytes: a blob of the other session cannot be stored in this one. */
  async function rebuild (value, memo) {
    if (value === null || typeof value !== 'object') return value
    if (memo.has(value)) return memo.get(value)
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      var bytes = await value.arrayBuffer()
      var copy = typeof File !== 'undefined' && value instanceof File
        ? new File([bytes], value.name, { type: value.type, lastModified: value.lastModified })
        : new Blob([bytes], { type: value.type })
      memo.set(value, copy)
      return copy
    }
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value) || value instanceof Date || value instanceof RegExp || value instanceof Error) return value
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return value
    memo.set(value, value)
    if (value instanceof Map) {
      var entries = Array.from(value)
      value.clear()
      for (var e = 0; e < entries.length; e++) value.set(await rebuild(entries[e][0], memo), await rebuild(entries[e][1], memo))
    } else if (value instanceof Set) {
      var members = Array.from(value)
      value.clear()
      for (var m = 0; m < members.length; m++) value.add(await rebuild(members[m], memo))
    } else if (Array.isArray(value)) {
      for (var i = 0; i < value.length; i++) value[i] = await rebuild(value[i], memo)
    } else {
      var names = Object.keys(value)
      for (var j = 0; j < names.length; j++) {
        Object.defineProperty(value, names[j], { value: await rebuild(value[names[j]], memo), enumerable: true, writable: true, configurable: true })
      }
    }
    return value
  }

  function deleteDatabase (name) {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.deleteDatabase(name)
      req.onsuccess = function () { resolve() }
      req.onerror = function () { reject(req.error) }
      req.onblocked = function () { reject(new Error('the database is blocked')) }
    })
  }

  async function writeSchema (spec) {
    try {
      await deleteDatabase(spec.name)
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

  /** Takes the batch the reading page posted under args.id and stores it. A record counts as written only when its transaction completed. */
  async function writeBatch (args) {
    var db = writing.get(args.db)
    if (db === undefined) throw new Error('the database was not made by the carry')
    var batch = await takeBatch(args.id)
    var problems = []
    var ready = []
    var memo = new Map()
    for (var i = 0; i < batch.records.length; i++) {
      try {
        ready.push({ key: batch.records[i].key, value: await rebuild(batch.records[i].value, memo) })
      } catch (error) {
        problems.push('record ' + (args.offset + i + 1) + ': ' + messageOf(error))
      }
    }
    var accepted = 0
    var aborted = await new Promise(function (resolve) {
      var tx = db.transaction(args.store, 'readwrite')
      var store = tx.objectStore(args.store)
      tx.oncomplete = function () { resolve(null) }
      tx.onabort = function () { resolve(messageOf(tx.error)) }
      ready.forEach(function (row, position) {
        try {
          var req = store.keyPath === null ? store.put(row.value, row.key) : store.put(row.value)
          req.onsuccess = function () { accepted += 1 }
          req.onerror = function (event) {
            event.preventDefault()
            event.stopPropagation()
            problems.push('record ' + (args.offset + position + 1) + ': ' + messageOf(req.error))
          }
        } catch (error) {
          problems.push('record ' + (args.offset + position + 1) + ': ' + messageOf(error))
        }
      })
      if (ready.length === 0) resolve(null)
    })
    if (aborted !== null) return JSON.stringify({ written: 0, problems: problems, aborted: aborted })
    return JSON.stringify({ written: accepted, problems: problems })
  }

  async function dropDatabase (name) {
    var kept = writing.get(name)
    if (kept !== undefined) kept.close()
    writing.delete(name)
    try {
      await deleteDatabase(name)
      return JSON.stringify({ dropped: true })
    } catch (error) {
      return JSON.stringify({ dropped: false, reason: messageOf(error) })
    }
  }

  function closeAll () {
    if (port !== null) {
      port.close()
      port = null
    }
    reading.forEach(function (db) { db.close() })
    writing.forEach(function (db) { db.close() })
    reading.clear()
    writing.clear()
    cursors.clear()
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
    var problems = []
    entries.forEach(function (entry, position) {
      try {
        localStorage.setItem(entry[0], entry[1])
        carried += 1
      } catch (error) {
        problems.push('item ' + (position + 1) + ': ' + messageOf(error))
      }
    })
    return JSON.stringify({ carried: carried, problems: problems })
  }

  var api = { connect: connect, readDatabases: readDatabases, sendBatch: sendBatch, writeSchema: writeSchema, writeBatch: writeBatch, dropDatabase: dropDatabase, closeAll: closeAll, readLocalStorage: readLocalStorage, writeLocalStorage: writeLocalStorage }
  Object.defineProperty(root, NAME, { value: api, enumerable: false, writable: false, configurable: false })
  return 'ready'
})(__NONCE__)`
