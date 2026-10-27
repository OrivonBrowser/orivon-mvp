/**
 * What the job leaves for other tools to read: the Web3 Score id of a version in Swarm, and the feeds file, the one
 * place a status page finds each site's feed manifest. The feeds file is a comment line, then `<ipns-key> bzz://<feed
 * manifest>` for each site that has a manifest, in names-file order. It is replaced all at once, and only when its text
 * differs from what this machine wrote last, so a timer that finds nothing new does not reach the remote host.
 */
import { createHash } from 'node:crypto'
import { renameSync, writeFileSync } from 'node:fs'
import { CID } from 'multiformats/cid'
import * as Digest from 'multiformats/hashes/digest'
import { saveState } from './store.mjs'
import { writeRemoteFile } from './ssh.mjs'

const SWARM_MANIFEST = 0xfa
const KECCAK_256 = 0x1b
const HEADER = '# <ipns-key> bzz://<feed manifest>, one line per site. Written by swarm-feeds.mjs: edits are overwritten.'

/**
 * @param {string} reference a Swarm reference, 64 lowercase hex characters
 * @returns {string} the id Web3 Score knows that version by: `cid:` and its CIDv1 (swarm-manifest over keccak-256)
 */
export function scoreId (reference) {
  if (!/^[0-9a-f]{64}$/.test(reference)) throw new RangeError('a Swarm reference is 64 lowercase hex characters')
  return `cid:${CID.createV1(SWARM_MANIFEST, Digest.create(KECCAK_256, Uint8Array.from(Buffer.from(reference, 'hex')))).toString()}`
}

/**
 * @param {{ key: string }[]} sites in names-file order
 * @param {{ sites: Record<string, any> }} state
 * @returns {string | null} the feeds file's text, null when no site has a manifest yet
 */
export function feedsText (sites, state) {
  const lines = sites.flatMap(({ key }) => (state.sites[key]?.manifest === undefined ? [] : [`${key} bzz://${String(state.sites[key].manifest)}`]))
  return lines.length === 0 ? null : `${HEADER}\n${lines.join('\n')}\n`
}

/**
 * Writes the feeds file when its text is not the one written last to the same place, and records what was written.
 * @param {{ target: string, sites: { key: string }[], ctx: import('./sites.mjs').SiteCtx, spawnFn?: import('./ssh.mjs').SpawnFn }} input target: a path or ssh://user@host/absolute/path
 * @returns {Promise<void>}
 */
export async function updateFeedsFile ({ target, sites, ctx, spawnFn }) {
  const text = feedsText(sites, ctx.state)
  if (text === null) return
  const sha256 = createHash('sha256').update(text).digest('hex')
  if (ctx.state.feedsFile?.target === target && ctx.state.feedsFile.sha256 === sha256) return
  if (target.startsWith('ssh://')) await writeRemoteFile(target, text, spawnFn)
  else {
    writeFileSync(`${target}.tmp`, text)
    renameSync(`${target}.tmp`, target)
  }
  ctx.state.feedsFile = { target, sha256 }
  saveState(ctx.cfg.stateDir, ctx.state)
  ctx.log('wrote the feeds file')
  ctx.summary(`feeds file written: ${String(text.split('\n').length - 2)} site(s)`)
}
