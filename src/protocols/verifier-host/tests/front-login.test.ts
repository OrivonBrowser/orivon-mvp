import { describe, expect, it, vi } from 'vitest'
import { answerForFront } from '../front-login.js'

const FRONT = { port: 4040, username: 'orivon', password: 'secret' }

describe('what the verifier host answers a proxy that asks it to sign in', () => {
  it('gives the front\'s secret to the front on this computer, at its port', () => {
    const callback = vi.fn()
    answerForFront(FRONT)({ isProxy: true, host: '127.0.0.1', port: 4040 }, callback)
    expect(callback).toHaveBeenCalledWith('orivon', 'secret')
  })

  it('gives it to nothing else: another port, another host, or a server that is not a proxy', () => {
    for (const info of [{ isProxy: true, host: '127.0.0.1', port: 4041 }, { isProxy: true, host: '10.0.0.5', port: 4040 }, { isProxy: false, host: '127.0.0.1', port: 4040 }]) {
      const callback = vi.fn()
      answerForFront(FRONT)(info, callback)
      expect(callback, JSON.stringify(info)).toHaveBeenCalledWith()
    }
  })
})
