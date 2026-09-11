/**
 * Fails the build if a credential is committed to this repository.
 *
 * github.com/OrivonBrowser/orivon-mvp is PUBLIC. A token pushed here is
 * scraped by automated crawlers within minutes, and the account or bot behind
 * it is used before anyone notices. Deleting the commit does not help -- it
 * stays in the object store and in every fork and clone.
 *
 * The autonomous build loop (docs/planning/autonomous-loop-design.md) sends
 * notifications through a Telegram bot, so a real credential now exists for
 * this project. It lives in ~/.config/orivon/notify.env, mode 600, deliberately
 * OUTSIDE the repository. This guard is what stops that arrangement from
 * quietly decaying.
 *
 * SCOPE: git-tracked files only. Untracked scratch files and gitignored state
 * cannot reach GitHub, and scanning them produces false alarms that get the
 * guard switched off -- which is the failure mode worth avoiding most.
 *
 * OUTPUT: findings never contain the matched value. CI logs on a public repo
 * are public, so a guard that prints what it found has published it twice.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isInvokedDirectly, trackedFiles } from './cli.mjs'

/**
 * Each pattern matches a credential FORMAT that is issued, not typed by a
 * human. That is what keeps false positives low enough for the guard to
 * survive: a developer does not accidentally write 36 random base62
 * characters after `ghp_`.
 */
const PATTERNS = [
  { kind: 'telegram-bot-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{32,34}\b/ },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { kind: 'slack-token', re: /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/ },
  { kind: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { kind: 'generic-bearer', re: /\bBearer\s+[A-Za-z0-9_\-.]{40,}\b/ }
]

/**
 * Files exempt from scanning, and why each is safe.
 *
 * - This guard's own source, which necessarily contains the patterns.
 * - Its test, which necessarily contains sample values.
 * - `*.example` / `*.sample`, whose whole purpose is showing the shape.
 *
 * Deliberately NOT exempt: documentation. A doc is exactly where someone
 * pastes a real token "just as an example".
 */
const EXEMPT = [
  /(^|\/)check-no-secrets\.(mjs|test\.ts)$/,
  /\.(example|sample)$/,
  /(^|\/)\.env\.example$/
]

/**
 * Marks text that is illustrating a credential's SHAPE, not showing a real
 * one. `for example` / `e.g.` were dropped (R-S5-05): they are generic
 * transition phrases used constantly for reasons that have nothing to do
 * with secrets, and reproduced with a real credential -- "Our real deploy
 * token, for example, is ghp_..." -- they hid it.
 */
const DESCRIPTIVE = /\b(look like|looks like|placeholder|never commit|followed by)\b/i

/**
 * How far, in characters, a DESCRIPTIVE marker must sit from a match to
 * exempt it -- the other half of R-S5-05. Matching used to apply to the
 * WHOLE line, so a marker anywhere on a long line exempted every credential
 * on it, however far away.
 */
const DESCRIPTIVE_WINDOW = 40

/**
 * Binary formats, skipped by extension as well as by content sniffing. The NUL
 * heuristic below catches almost everything, but an extension check is cheaper
 * on large assets and covers formats that happen not to have an early NUL.
 */
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|avif|pdf|zip|gz|tar|xz|bz2|7z|woff2?|ttf|otf|eot|mp[34]|m4[av]|mkv|webm|wav|flac|node|wasm|so|dylib|dll|exe|bin|class|jar)$/i

/**
 * @param {string} root Repository root to scan.
 * @param {{ knownSecrets?: string[] }} [opts] Literal credential values
 *   configured on this machine. Checked in EVERY tracked file, including the
 *   exempt ones -- see the live-credential pass below.
 * @returns {{ ok: boolean, findings: Array<{file: string, line: number, kind: string}>, error?: string }}
 *   Findings carry the location and the KIND only -- never the value. `error`
 *   is set, and `ok` is false with an empty `findings`, when the tracked-file
 *   list itself could not be obtained (R-S5-04) -- a caller must treat that
 *   as a failed scan, never as a clean one.
 */
export function checkNoSecrets (root, opts = {}) {
  const findings = []

  let files
  try {
    files = trackedFiles(root)
  } catch (err) {
    return { ok: false, findings: [], error: `could not list git-tracked files under ${root}: ${err.message}` }
  }

  /**
   * The live-credential pass exists because of a real incident during
   * development: a genuine Telegram bot token was pasted into this guard's own
   * TEST FILE as a fixture. That file is necessarily exempt from pattern
   * matching -- a test for a secret scanner must contain token-shaped strings
   * -- so the guard could not see itself, and the pattern pass reported clean.
   *
   * Matching literal values needs no patterns and honours no exemptions, so it
   * closes that hole for good. It is local-only: ~/.config/orivon/notify.env
   * does not exist on a CI runner, where the pattern pass is the control.
   */
  const live = (opts.knownSecrets ?? readConfiguredSecrets())
    // Short values ("telegram", "none") appear everywhere and would make the
    // guard useless. A real credential is not 12 characters.
    .filter((value) => typeof value === 'string' && value.length >= 16)

  for (const file of files) {
    if (BINARY_EXT.test(file)) continue

    const text = readTextFile(join(root, file))
    if (text === null) continue // unreadable or binary

    const exempt = EXEMPT.some((re) => re.test(file))
    const lines = text.split('\n')

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? ''

      // Pass 1: a live credential, in ANY file. Exemptions do not apply.
      if (live.some((value) => line.includes(value))) {
        findings.push({ file, line: i + 1, kind: 'live-credential' })
        continue
      }

      // Pass 2: credential-shaped strings, in non-exempt files.
      if (exempt) continue
      for (const { kind, re } of PATTERNS) {
        const match = re.exec(line)
        if (!match) continue
        if (isDescriptiveNear(line, match.index, DESCRIPTIVE_WINDOW)) continue
        findings.push({ file, line: i + 1, kind })
        break // one finding per line is enough to fail the build
      }
    }
  }

  findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  return { ok: findings.length === 0, findings }
}

/**
 * Values from the local notification config, so the guard can detect the
 * actual credentials in use. Absent on CI, which is expected and fine.
 */
function readConfiguredSecrets () {
  const path = process.env.ORIVON_NOTIFY_CONFIG ??
    join(homedir(), '.config', 'orivon', 'notify.env')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .map((line) => line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** True when a DESCRIPTIVE marker sits within `window` characters of a match at `index` -- not merely somewhere on the same line. */
function isDescriptiveNear (line, index, window) {
  const start = Math.max(0, index - window)
  const end = Math.min(line.length, index + window)
  return DESCRIPTIVE.test(line.slice(start, end))
}

/** Returns null for unreadable files and for anything that looks binary. */
function readTextFile (path) {
  let buffer
  try {
    buffer = readFileSync(path)
  } catch {
    return null
  }
  // A NUL byte in the first 8 KiB is the standard heuristic for "binary".
  if (buffer.subarray(0, 8192).includes(0)) return null
  return buffer.toString('utf8')
}

if (isInvokedDirectly(import.meta.url)) {
  const { ok, findings, error } = checkNoSecrets(process.cwd())

  if (!ok) {
    if (error) {
      console.error(`\n${error}\nTreating this as a failed scan, not a clean one.\n`)
    }
    if (findings.length > 0) {
      console.error('\nCredentials found in git-tracked files:\n')
      for (const { file, line, kind } of findings) {
        console.error(`  ${file}:${line}  [${kind}]`)
      }
      console.error(
        '\nThis repository is PUBLIC. Do not simply delete the line and commit --' +
        '\nif it was ever pushed, treat the credential as compromised and ROTATE IT,' +
        '\nthen move it to ~/.config/orivon/notify.env (mode 600), outside the repo.\n'
      )
    }
    process.exit(1)
  }

  console.log('No credentials in git-tracked files.')
}
