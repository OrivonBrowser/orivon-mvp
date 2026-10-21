// The commit a build is made from, for the report page's technical details: `git rev-parse --short=12 HEAD`,
// with `-dirty` after it when the working tree has changes, and `unknown` when git cannot say.
import { execFileSync } from 'node:child_process'

export function buildCommit (cwd: string): string {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim()
  try {
    const head = git('rev-parse', '--short=12', 'HEAD')
    return /^[0-9a-f]{7,40}$/.test(head) ? `${head}${git('status', '--porcelain') === '' ? '' : '-dirty'}` : 'unknown'
  } catch {
    return 'unknown'
  }
}
