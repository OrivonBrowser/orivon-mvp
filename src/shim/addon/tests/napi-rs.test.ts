// A real napi-rs addon, built for wasm32-wasip1 outside this repository
// (ADR-0002), loaded through the addon loader as `process.dlopen` loads one:
// plain calls, strings, async work resolving a promise, and a file read
// through a Worker's synchronous orivon. Runs only when
// ORIVON_NAPI_RS_ADDON names the built .wasm. The crate `napiaddon`, with
// `crate-type = ["cdylib"]`, napi 3 (default-features = false, "napi4"),
// napi-derive 3, napi-build 2 (`napi_build::setup()` in build.rs):
//
//   use napi::{bindgen_prelude::*, Env, Task};
//   use napi_derive::napi;
//   #[napi] pub fn add(a: i32, b: i32) -> i32 { a + b }
//   #[napi] pub fn hello(name: String) -> String { format!("hello {name} from napi-rs") }
//   #[napi] pub fn read_text(path: String) -> Result<String> {
//     std::fs::read_to_string(&path).map_err(|e| Error::from_reason(format!("{path}: {e}"))) }
//   pub struct Square(u32);
//   impl Task for Square { type Output = u32; type JsValue = u32;
//     fn compute(&mut self) -> Result<u32> { Ok(self.0 * self.0) }
//     fn resolve(&mut self, _env: Env, output: u32) -> Result<u32> { Ok(output) } }
//   #[napi] pub fn square_async(n: u32) -> AsyncTask<Square> { AsyncTask::new(Square(n)) }
//
//   npm install --prefix <emnapi> emnapi@2.0.0-alpha.5   (the archive napi-build links)
//   EMNAPI_LINK_DIR=<emnapi>/node_modules/emnapi/lib/wasm32-wasip1 cargo build --release --target wasm32-wasip1
//   ORIVON_NAPI_RS_ADDON=target/wasm32-wasip1/release/napiaddon.wasm npx vitest run src/shim/addon/tests/napi-rs.test.ts
//
// Last run with napi 3.13.0 and Rust 1.98.1: every case passes.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { SYNCHRONOUS } from '../../worker/sync-channel.js'
import { loadAddon } from '../index.js'

const ADDON = process.env.ORIVON_NAPI_RS_ADDON

interface NapiRsAddon {
  add: (a: number, b: number) => number
  hello: (name: string) => string
  readText: (path: string) => string
  squareAsync: (n: number) => Promise<number>
}

function serve (path: string): void {
  const bytes = readFileSync(ADDON as string)
  class FakeRequest {
    status = 0
    response: ArrayBuffer | null = null
    responseType = ''
    #url = ''
    open (_method: string, url: string): void { this.#url = url }
    overrideMimeType (): void {}
    send (): void {
      const found = new URL(this.#url).pathname === path
      this.status = found ? 200 : 404
      this.response = found ? bytes.slice().buffer : null
    }
  }
  vi.stubGlobal('XMLHttpRequest', FakeRequest)
  vi.stubGlobal('location', { origin: 'https://app.test' })
}

afterEach(() => { vi.unstubAllGlobals() })

describe.skipIf(ADDON === undefined)('a real napi-rs addon, wasm32-wasip1', () => {
  it('answers plain calls and strings, and resolves async work', async () => {
    serve('/native/napiaddon.wasm')
    const addon = loadAddon('/native/napiaddon.node') as NapiRsAddon
    expect(addon.add(2, 3)).toBe(5)
    expect(addon.hello('orivon')).toBe('hello orivon from napi-rs')
    expect(await addon.squareAsync(7)).toBe(49)
  })

  it('reads a file through a Worker\'s synchronous orivon, as in a forked child of an isolated app', async () => {
    const disk = await createRealDiskFs()
    try {
      writeFileSync(join(disk.root, 'note.txt'), 'read by a napi-rs addon')
      serve('/native/napiaddon-files.wasm')
      vi.stubGlobal('orivon', { [SYNCHRONOUS]: { fs: disk.syncFs } })
      expect((loadAddon('/native/napiaddon-files.node') as NapiRsAddon).readText('note.txt')).toBe('read by a napi-rs addon')
    } finally {
      await disk.cleanup()
    }
  })
})
