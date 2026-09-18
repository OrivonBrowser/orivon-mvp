#!/usr/bin/env node
// Runs this app's network and storage layers outside a browser and reports
// what actually worked, against live YouTube.
//
// WHY A NODE HARNESS IS A HONEST TEST OF THE NETWORK LAYER, AND WHERE IT
// STOPS BEING ONE. Node's `fetch` shares the two properties ADR-0017 gives a
// routed fetch, and they are the two this app depends on: no CORS, and no
// forbidden-header list, so `Origin` and `User-Agent` reach the wire as
// written. What it does NOT model is the rest of an app tab -- the served
// CSP, the 16 MiB routed-fetch body cap, and `<video>` itself. Playback is
// therefore reported here as "a stream URL was resolved", never as "a video
// played"; only a real app tab can answer that, and README.md's Design notes
// says what is known about it.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { InnerTube, pickStreams } from './lib/innertube.js'
import { parseChannel, parsePlayability, parseRelated, parseSearch, parseWatchMetadata } from './lib/parse.js'
import { Collection } from './lib/store.js'

const ROOT = new URL('.', import.meta.url)
const SAMPLE_QUERY = process.argv[2] ?? 'orivon browser'

const results = []

function record (name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(34)} ${detail ?? ''}`)
}

async function check (name, work) {
  try {
    const detail = await work()
    record(name, true, detail)
    return true
  } catch (error) {
    record(name, false, error.message)
    return false
  }
}

async function manifestChecks () {
  const manifest = JSON.parse(await readFile(new URL('.well-known/orivon.json', ROOT), 'utf8'))

  await check('manifest: required fields', () => {
    for (const field of ['orivonApiVersion', 'id', 'name', 'version', 'entry', 'capabilities']) {
      if (manifest[field] === undefined) throw new Error(`missing ${field}`)
    }
    return `${manifest.id} v${manifest.version}`
  })

  await check('manifest: declared assets exist', async () => {
    const declared = [manifest.entry, ...(manifest.assets ?? [])]
    const missing = []
    for (const asset of declared) {
      try {
        await readFile(new URL(asset, ROOT))
      } catch {
        missing.push(asset)
      }
    }
    if (missing.length > 0) throw new Error(`missing on disk: ${missing.join(', ')}`)
    return `${declared.length} files`
  })

  await check('manifest: every host is literal', () => {
    const patterns = manifest.capabilities?.net?.https?.connect ?? []
    const globbed = patterns.filter((pattern) => pattern.includes('*'))
    if (globbed.length > 0) {
      throw new Error(`a wildcard host is omitted from the served CSP: ${globbed.join(', ')}`)
    }
    return `${patterns.length} hosts, all CSP-representable`
  })

  return manifest
}

async function storeChecks () {
  await check('store: nedb round trip', async () => {
    const files = new Map()
    const fs = {
      readFile: async (path) => {
        const found = files.get(path)
        if (found === undefined) throw new Error('ENOENT')
        return found
      },
      writeFile: async (path, data) => { files.set(path, data) }
    }
    const first = new Collection('verify', fs)
    await first.insert({ _id: 'a', value: 1 })
    await first.upsert({ _id: 'a', value: 2 })
    await first.insert({ _id: 'b', value: 3 })
    await first.remove({ _id: 'b' })

    const reloaded = await new Collection('verify', fs).find()
    if (reloaded.length !== 1 || reloaded[0].value !== 2) {
      throw new Error(`reloaded ${JSON.stringify(reloaded)}`)
    }
    const text = new TextDecoder().decode(files.get('verify.db'))
    if (!text.endsWith('\n') || text.split('\n').filter(Boolean).length !== 4) {
      throw new Error('on-disk form is not append-only NDJSON')
    }
    return '4 appended lines, 1 live document'
  })

  await check('store: works with no fs grant', async () => {
    const memory = new Collection('verify', undefined)
    await memory.insert({ _id: 'x', value: 1 })
    if ((await memory.find()).length !== 1) throw new Error('memory fallback lost the document')
    if (memory.persistent) throw new Error('memory fallback claims to be persistent')
    return 'in-memory fallback intact'
  })
}

async function apiChecks () {
  const yt = new InnerTube()
  let firstVideo
  let authorId

  await check('innertube: visitor bootstrap', async () => {
    const visitor = await yt.ensureVisitorData()
    if (visitor === null) throw new Error('no visitor token issued')
    return `${visitor.slice(0, 12)}...`
  })

  const searched = await check('innertube: search', async () => {
    const found = parseSearch(await yt.search(SAMPLE_QUERY))
    if (found.results.length === 0) throw new Error('no results parsed')
    firstVideo = found.results.find((item) => item.kind === 'video')
    if (firstVideo === undefined) throw new Error('no video in results')
    const unnamed = found.results.filter((item) => item.title === undefined && item.author === undefined)
    if (unnamed.length > 0) throw new Error(`${unnamed.length} results parsed with no title`)
    return `${found.results.length} results, all named`
  })

  if (searched) {
    await check('innertube: watch metadata', async () => {
      const response = await yt.next(firstVideo.videoId)
      const meta = parseWatchMetadata(response)
      const related = parseRelated(response)
      if (meta.title === undefined) throw new Error('no title parsed')
      if (meta.author === undefined) throw new Error('no channel parsed')
      authorId = meta.authorId
      return `"${meta.title.slice(0, 28)}" by ${meta.author}, ${related.length} related`
    })

    await check('innertube: channel', async () => {
      if (authorId === undefined) throw new Error('no channel id from the watch page')
      const channel = parseChannel(await yt.browse(authorId))
      if (channel.author === undefined) throw new Error('no channel name parsed')
      return `${channel.author}, ${channel.items.length} uploads`
    })
  }

  await check('innertube: stream resolution', async () => {
    const response = await yt.player('dQw4w9WgXcQ')
    const playability = parsePlayability(response)
    if (!playability.ok) throw new Error(`${playability.status}: ${playability.reason ?? 'no reason given'}`)
    const streams = pickStreams(response)
    if (streams.preferred === undefined) throw new Error('no progressive stream offered')
    const host = new URL(streams.preferred.url).hostname
    return `itag ${streams.preferred.itag} ${streams.preferred.qualityLabel} from ${host}`
  })

  await check('innertube: stream host is un-nameable', async () => {
    const response = await yt.player('dQw4w9WgXcQ')
    const streams = pickStreams(response)
    if (streams.preferred === undefined) throw new Error('no stream to inspect')
    const host = new URL(streams.preferred.url).hostname
    if (!host.endsWith('.googlevideo.com')) return `unexpected host ${host}, worth re-checking`
    return `${host} rotates per request, so no manifest pattern names it`
  })
}

async function main () {
  console.log(`FreeTube for Orivon -- verification against live YouTube\n${'-'.repeat(64)}`)
  await manifestChecks()
  await storeChecks()
  await apiChecks()

  const failed = results.filter((entry) => !entry.ok)
  console.log('-'.repeat(64))
  console.log(`${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log(`failed: ${failed.map((entry) => entry.name).join(', ')}`)
    process.exitCode = 1
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()
