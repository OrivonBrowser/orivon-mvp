/**
 * The pinning node's Kubo RPC (POST only): the IPNS keys, what each points at, and a version as a tar. The node is reached
 * over http(s), or over ssh (`IPFS_API=ssh://user@host`, see ssh.mjs). A tar is unpacked and packed again by GNU `tar` so
 * that its entries are the site's own paths (`./index.html`, `./.well-known/orivon.json`), which is what Bee's collection
 * upload takes.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { reachFailure } from './bee.mjs'
import { parseSshUrl, sshKubo } from './ssh.mjs'

const CID = /^(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{50,})$/

/**
 * @param {{ base: string, fetchFn: typeof fetch }} config
 * @returns {{ text: (path: string, timeout: number) => Promise<string>, stream: (path: string, timeout: number) => Promise<Readable> }}
 */
function httpKubo ({ base, fetchFn }) {
  /** @param {string} path @param {number} timeout */
  const post = async (path, timeout) => {
    /** @type {Response} */
    let response
    try {
      response = await fetchFn(`${base}/api/v0/${path}`, { method: 'POST', signal: AbortSignal.timeout(timeout) })
    } catch (error) {
      throw new Error(`cannot reach Kubo at ${base} (${reachFailure(error)})`)
    }
    if (!response.ok) throw new Error(`Kubo ${path.split('?')[0] ?? path} answered ${String(response.status)}`)
    return response
  }
  return {
    text: async (path, timeout) => (await post(path, timeout)).text(),
    stream: async (path, timeout) => {
      const response = await post(path, timeout)
      if (response.body === null) throw new Error(`Kubo ${path.split('?')[0] ?? path} gave no body`)
      return Readable.fromWeb(/** @type {any} */ (response.body))
    }
  }
}

/**
 * @param {{ api: string, rpc?: string, fetchFn?: typeof fetch, spawnFn?: import('./ssh.mjs').SpawnFn }} config `api` is an http(s) URL or `ssh://user@host[:port]`, in which case `rpc` is the node's RPC address as the remote machine sees it
 */
export function kuboClient ({ api, rpc = 'http://127.0.0.1:5001', fetchFn = fetch, spawnFn }) {
  const target = parseSshUrl(api, { path: false })
  const transport = target === null ? httpKubo({ base: api.replace(/\/+$/, ''), fetchFn }) : sshKubo({ target, rpc, spawnFn })
  return {
    /** @returns {Promise<{ name: string, id: string }[]>} every key but the node's own */
    async keys () {
      const body = /** @type {any} */ (JSON.parse(await transport.text('key/list?l=true&ipns-base=base36', 120_000)))
      return (body.Keys ?? []).filter((/** @type {any} */ k) => k.Name !== 'self').map((/** @type {any} */ k) => ({ name: String(k.Name), id: String(k.Id) }))
    },
    /**
     * The CID a key points at, from the node's own record: the node published it, so nothing is asked of the network.
     * @param {string} id
     * @returns {Promise<string>}
     */
    async resolve (id) {
      const body = /** @type {any} */ (JSON.parse(await transport.text(`name/resolve?arg=${encodeURIComponent(`/ipns/${id}`)}&offline=true`, 120_000)))
      const cid = String(body.Path ?? '').replace(/^\/ipfs\//, '')
      if (!CID.test(cid)) throw new Error(`${id} does not point at a CID`)
      return cid
    },
    /** @param {string} cid @returns {Promise<Readable>} the version as a tar whose entries start with `<cid>/` */
    async archive (cid) {
      if (!CID.test(cid)) throw new Error(`"${cid}" is not a CID`)
      return transport.stream(`get?arg=${encodeURIComponent(`/ipfs/${cid}`)}&archive=true`, 3_600_000)
    }
  }
}

/**
 * @param {string[]} args
 * @param {Readable} [input]
 * @returns {Promise<void>}
 */
function runTar (args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', args, { stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += String(chunk) })
    /** @type {unknown} */
    let inputError
    child.on('error', reject)
    // A download that breaks leaves tar a short archive: the download's own error is the one worth reporting.
    if (input !== undefined && child.stdin !== null) pipeline(input, child.stdin).catch((error) => { inputError = error })
    child.on('close', (code) => {
      if (inputError !== undefined) reject(inputError)
      else if (code === 0) resolve()
      else reject(new Error(`tar ${String(args[0])} failed (${String(code)}): ${stderr.trim().slice(0, 300)}`))
    })
  })
}

/** Removes what a run killed halfway left in the work directory. @param {string} workDir */
export function clearWork (workDir) {
  let names = []
  try { names = readdirSync(workDir) } catch { return }
  for (const name of names) if (name.startsWith('site-')) rmSync(join(workDir, name), { recursive: true, force: true })
}

/**
 * A version as a tar file of the site's own paths, dotfiles included, ready to upload. The download is streamed through
 * `tar` into a folder and packed again; the folder is removed as soon as the tar exists, so one site holds the disk once.
 * @param {{ kubo: ReturnType<typeof kuboClient>, cid: string, workDir: string }} input
 * @returns {Promise<{ file: string, bytes: number, hasIndex: boolean, cleanup: () => void }>}
 */
export async function packSite ({ kubo, cid, workDir }) {
  mkdirSync(workDir, { recursive: true })
  const dir = mkdtempSync(join(workDir, 'site-'))
  const cleanup = () => { rmSync(dir, { recursive: true, force: true }) }
  try {
    const tree = join(dir, 'tree')
    const file = join(dir, 'site.tar')
    mkdirSync(tree)
    await runTar(['-x', '-C', tree, '--strip-components=1', '--no-same-owner', '-f', '-'], await kubo.archive(cid))
    if (readdirSync(tree).length === 0) throw new Error(`${cid} holds no files: a site is a folder`)
    const hasIndex = existsSync(join(tree, 'index.html'))
    await runTar(['-c', '-C', tree, '-f', file, '.'])
    rmSync(tree, { recursive: true, force: true })
    return { file, bytes: statSync(file).size, hasIndex, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}
