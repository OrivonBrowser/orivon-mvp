// The shim builtins a run-time `require('name')` can return: every module-map.ts
// row but the ones below, which stand on heavier machinery than a CommonJS
// loader should pull into every bundle that has one (child_process, wasi,
// worker_threads, module, electron). An app that needs one of those at run
// time registers it with registerBuiltin. Statically imported, so a bundle
// holds them whether or not a require ever asks.

import assert from './assert.js'
import asyncHooks from './async-hooks.js'
import buffer from './buffer.js'
import consoleModule from './console.js'
import crypto from './crypto.js'
import diagnosticsChannel from './diagnostics-channel.js'
import events from 'events'
import fs from '../fs/fs.js'
import fsPromises from '../fs/promises.js'
import http from '../http/http.js'
import http2 from './http2.js'
import https from '../http/https.js'
import dgram from '../net/dgram.js'
import dns from '../net/dns.js'
import dnsPromises from '../net/dns-promises.js'
import net from '../net/net.js'
import tls from '../net/tls.js'
import os from './os.js'
import path from './path.js'
import processModule from './process.js'
import perfHooks from './perf-hooks.js'
import querystring from './querystring.js'
import readline from './readline.js'
import stream from 'stream'
import streamPromises from './stream-promises.js'
import stringDecoder from './string-decoder.js'
import timers from './timers.js'
import timersPromises from './timers-promises.js'
import tty from './tty.js'
import url from './url.js'
import util from './util.js'
import utilTypes from './util-types.js'
import vm from './vm.js'
import zlib from './zlib.js'

const registry = new Map<string, unknown>(Object.entries({
  assert, async_hooks: asyncHooks, buffer, console: consoleModule, crypto, diagnostics_channel: diagnosticsChannel,
  dgram, dns, 'dns/promises': dnsPromises, events, fs, 'fs/promises': fsPromises, http, http2, https, net, os, path,
  'path/posix': path, process: processModule, perf_hooks: perfHooks, querystring, readline, stream, 'stream/promises': streamPromises,
  string_decoder: stringDecoder, timers, 'timers/promises': timersPromises, tls, tty, url, util, 'util/types': utilTypes, vm, zlib
}))

/** Makes `require(name)` (bare or `node:`-prefixed) return `exports`. */
export function registerBuiltin (name: string, exports: unknown): void {
  registry.set(name.replace(/^node:/, ''), exports)
}

export function hasBuiltin (name: string): boolean {
  return registry.has(name.replace(/^node:/, ''))
}

export function loadBuiltin (name: string): unknown {
  return registry.get(name.replace(/^node:/, ''))
}
