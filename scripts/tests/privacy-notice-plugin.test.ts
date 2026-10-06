import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createServer } from 'vite'
import { PRIVACY_NOTICE_MODULE, privacyNotice } from '../privacy-notice-plugin.js'

const NOTICE = join(import.meta.dirname, '../../docs/privacy/notice.md')

describe('privacyNotice', () => {
  it('serves docs/privacy/notice.md, whole, as the default export of its virtual module, through a real dev server', async () => {
    const server = await createServer({ root: join(import.meta.dirname, '../../src/renderer'), logLevel: 'silent', server: { middlewareMode: true }, plugins: [privacyNotice()] })
    try {
      const result = await server.transformRequest(PRIVACY_NOTICE_MODULE)
      expect(result?.code).toBe(`export default ${JSON.stringify(readFileSync(NOTICE, 'utf8'))}`)
    } finally {
      await server.close()
    }
  })

  it('leaves every other module alone', () => {
    const plugin = privacyNotice()
    const resolveId = plugin.resolveId as (id: string) => string | null
    expect(resolveId('./other.js')).toBeNull()
    expect(resolveId(PRIVACY_NOTICE_MODULE)).toBe(`\0${PRIVACY_NOTICE_MODULE}`)
  })
})
