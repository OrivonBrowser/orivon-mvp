// Transcribed from docs/architecture/capability-api.md SSv0 surface.
//
// THIS IS THE DURABLE ASSET (ADR-0002). Apps call orivon.net.connect; beneath
// it that is a Node net.Socket in the main process today, a Wasmtime host
// function later, Mojo IPC in a Chromium fork after that. None of those
// transitions is visible to an app already written, and that property -- not
// Electron, not Wasmtime -- is what keeps the path to a Chromium fork open.
//
// DESIGN RULES THIS FILE OBEYS:
//   2. Everything is async. Node constructs sockets synchronously; across an
//      IPC boundary we cannot. All entry points return Promises.
//   3. Handles, not ambient authority. connect() returns a handle; later
//      operations reference it. Capability is checked ONCE, at acquisition,
//      which avoids TOCTOU and avoids re-authorising on every call.
//   4. Declare statically, grant dynamically.
//   5. No capability is implicit.

import type {
  FileHandle,
  FileStat,
  IdentityHandle,
  TcpServer,
  TcpSocket,
  UdpSocket
} from './handles.js'
import type { Grant, Manifest, Pattern } from './manifest.js'

/** The root object injected into an app's page as `orivon`. */
export interface Orivon {
  readonly version: 0
  readonly app: OrivonApp
  readonly net: OrivonNet
  readonly fs: OrivonFs
  readonly id: OrivonId
}

export interface OrivonApp {
  manifest(): Promise<Manifest>
  /** What was ACTUALLY granted, which is a subset of what the manifest declares. */
  grants(): Promise<readonly Grant[]>
  /** May prompt the user. Resolves false if declined or not declared. */
  requestGrant(capability: CapabilityRequest): Promise<boolean>
}

export interface CapabilityRequest {
  readonly capability: string
  readonly patterns?: readonly Pattern[]
}

export interface OrivonNet {
  connect(opts: { host: string, port: number }): Promise<TcpSocket>
  listen(opts: { port: number }): Promise<TcpServer>
  udpBind(opts: { port: number }): Promise<UdpSocket>
}

/**
 * Rooted at the app's files directory. `..` traversal is rejected, resolved
 * and confined IN THE BROKER, never trusted from the renderer. Outside access
 * exists only through userSelected.
 *
 * The app's CODE CACHE is read-only to the app (ADR-0003): an app that could
 * rewrite its own code would escape the manifest its grants were issued
 * against.
 *
 * PROVISIONAL SIGNATURES. capability-api.md names these entry points but does
 * not specify their option bags ("orivon.fs.readFile(path, opts)",
 * "orivon.fs.mkdir / readdir / stat / rm / rename"). The byte-oriented forms
 * below are the minimal reading consistent with ADR-0008's layering -- bytes
 * and streams underneath, Node's shapes reconstructed by orivon-node-shim one
 * layer up, so encoding handling lives in the shim rather than here. Settled
 * during build step 2; see open-questions.md A12.
 */
export interface OrivonFs {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, data: Uint8Array): Promise<void>
  open(path: string, flags: string): Promise<FileHandle>
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  stat(path: string): Promise<FileStat>
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>
  rename(from: string, to: string): Promise<void>
  /** The OS file picker. The user's choice IS the consent -- no separate grant. */
  userSelected(opts?: { multiple?: boolean }): Promise<readonly FileHandle[]>
}

/**
 * TWO KINDS OF IDENTITY, and conflating them is a recorded past error
 * (capability-api.md SSTwo kinds of identity).
 *
 * APP KEYS -- publicKey/sign -- are per-origin and silent. They need no
 * consent because they cannot link users across apps.
 *
 * NAMED IDENTITIES -- requestIdentity -- are cross-origin BY DESIGN, behind an
 * explicit connect prompt per site. Nostr requires this: an npub must be the
 * SAME across every client, or follows, posts and identity fragment per
 * client. The original draft said `id` yields per-origin keys only, which
 * cannot support Nostr at all.
 *
 * The seed is never exposed and raw key export is not a capability at any
 * tier. Derive a distinct secret per (label, curve) with length-prefixed
 * HKDF -- one scalar reused across two schemes voids the security argument
 * for both.
 */
export interface OrivonId {
  /** derive(seed, "app", origin). Silent, no prompt. */
  publicKey(opts: { curve: string }): Promise<Uint8Array>
  sign(opts: { curve: string, payload: Uint8Array }): Promise<Uint8Array>
  /** derive(seed, "identity", identityId). Triggers the connect prompt. */
  requestIdentity(opts: { kind: string }): Promise<IdentityHandle | null>
}
