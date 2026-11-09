// An installed app that keeps an offline copy of itself, for the specs that need the session folder to hold real
// data: its service worker fills Cache Storage when it installs, and its page reports what it found there.

import type { Page } from 'playwright'
import type { Manifest } from '../../src/contracts/index.js'
import { waitFor } from '../support/smoke-helpers.mjs'

/** The manifest of the app served at `origin`'s name, which differs per spec so no two share an id. */
export function offlineCopyManifest (id: string): Manifest {
  return { orivonApiVersion: 0, id, name: 'Offline copy fixture', version: '1.0.0', entry: 'index.html', assets: ['app.js', 'sw.js'], capabilities: {} }
}

const WORKER = [
  "const CACHE = 'offline-copy'",
  "self.addEventListener('install', (event) => { event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['/', '/app.js']))) })",
  "self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()) })",
  "self.addEventListener('fetch', (event) => { event.respondWith(caches.match(event.request).then((hit) => hit ?? fetch(event.request))) })"
].join('\n')

// Reports on the body what happened, so a spec reads one string whichever step failed.
const PAGE_SCRIPT = [
  "const report = (state) => { document.body.dataset.copy = state }",
  "const within = (promise, ms, what) => Promise.race([promise, new Promise((resolve, reject) => { setTimeout(() => { reject(new Error(what + ' did not finish in ' + ms + ' ms')) }, ms) })])",
  "navigator.serviceWorker.register('/sw.js')",
  "  .then(() => within(navigator.serviceWorker.ready, 20000, 'the worker taking over'))",
  "  .then(() => caches.match('/app.js'))",
  "  .then((hit) => hit === undefined ? Promise.reject(new Error('the cache holds no /app.js')) : hit.text())",
  "  .then((text) => { report('cached ' + String(text.length) + ' bytes') }, (error) => { report('failed: ' + error.message) })"
].join('\n')

const encode = (text: string): Uint8Array => new TextEncoder().encode(text)

/** The files to pin, by path from the origin's root. */
export function offlineCopyFiles (): Record<string, Uint8Array> {
  return {
    '/index.html': encode('<!doctype html><title>offline copy</title><body>offline copy<script src="app.js"></script></body>'),
    '/app.js': encode(PAGE_SCRIPT),
    '/sw.js': encode(WORKER)
  }
}

/** What the page says its worker did once it has said anything: `cached <n> bytes`, or `failed: <why>`. */
export async function copyStateOf (view: Page): Promise<string> {
  let state = 'no state'
  await waitFor(async () => {
    state = await view.evaluate(() => document.body.dataset.copy ?? 'no state')
    return state !== 'no state'
  }, 40_000)
  return state
}
