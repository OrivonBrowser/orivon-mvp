// Registered as a setupFile in vitest.e2e.config.ts, so every e2e spec gets
// failure evidence with no edit of its own. See qa-evidence.mjs.

import { afterAll, afterEach } from 'vitest'
import { dropHeld, evidenceEnabled, writeFailureEvidence } from './qa-evidence.mjs'

const HOOK_TIMEOUT_MS = 30_000

afterEach(async (ctx) => {
  if (!evidenceEnabled()) return
  const result = ctx.task.result
  if (result?.state !== 'fail') {
    await dropHeld()
    return
  }
  const first = result.errors?.[0]
  await writeFailureEvidence({
    file: ctx.task.file.name,
    name: ctx.task.name,
    error: first?.stack ?? first?.message,
    retried: (result.retryCount ?? 0) > 0
  })
}, HOOK_TIMEOUT_MS)

afterAll(async () => { await dropHeld() }, HOOK_TIMEOUT_MS)
