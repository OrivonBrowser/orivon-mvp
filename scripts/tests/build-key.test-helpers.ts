import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execFileSync } from 'node:child_process'

export const GRANT_ENV = { ORIVON_ENABLE_DEV_GRANT: '1' }

export const git = (root: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' })
}

export const write = (root: string, path: string, body: string): void => {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), body)
}

export const commitAll = (root: string, message = 'change'): void => {
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--no-verify', '--allow-empty', '-m', message)
}

/** A git checkout holding a build's inputs, a file the build does not read, and an installed Electron. */
export function inputsRepo (): string {
  const root = mkdtempSync(join(tmpdir(), 'orivon-build-key-'))
  git(root, 'init', '-q')
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\nout/\nsrc/cache/\n',
    'package.json': '{"name":"app","version":"1.0.0"}\n',
    'package-lock.json': '{}\n',
    'tsconfig.json': '{}\n',
    'CHANGELOG.md': '# Changelog\n',
    'electron.vite.config.ts': 'export default {}\n',
    'src/main/index.ts': 'export const a = 1\n',
    'src/renderer/index.html': '<html></html>\n',
    'vendor/lib/index.js': 'module.exports = 1\n',
    'resources/flavours.json': '[]\n',
    'docs/privacy/notice.md': 'notice\n',
    'docs/elsewhere.md': 'prose\n',
    'scripts/build-commit.ts': 'export {}\n',
    'scripts/unrelated.mjs': 'export {}\n',
    'test/spec.test.ts': 'export {}\n'
  }
  for (const [path, body] of Object.entries(files)) write(root, path, body)
  commitAll(root, 'inputs')
  for (const name of ['electron', 'electron-vite', 'vite']) write(root, `node_modules/${name}/package.json`, `{"version":"1.0.0"}\n`)
  write(root, 'node_modules/.package-lock.json', '{}\n')
  return root
}
