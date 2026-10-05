// Clears qa-artifacts/latest/ once per vitest run, so what is there always
// belongs to the run that just finished.

import { mkdir, rm } from 'node:fs/promises'
import { LATEST_DIR } from './qa-evidence.mjs'

export default async function setup (): Promise<void> {
  await rm(LATEST_DIR, { recursive: true, force: true })
  await mkdir(LATEST_DIR, { recursive: true })
}
