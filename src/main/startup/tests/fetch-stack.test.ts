import { afterEach, describe, expect, it } from 'vitest'
import { loadFetchStack } from '../fetch-stack.js'

const realResponse = globalThis.Response

afterEach(() => { globalThis.Response = realResponse })

describe('loadFetchStack', () => {
  it('constructs a Response, which is where Node loads undici on first use', () => {
    let constructed = 0
    globalThis.Response = class extends realResponse {
      constructor (...args: ConstructorParameters<typeof realResponse>) {
        super(...args)
        constructed += 1
      }
    }

    loadFetchStack()

    expect(constructed).toBe(1)
  })
})
