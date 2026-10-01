import { describe, expect, it, vi } from 'vitest'
import { handleOpenUrl } from '../open-url.js'

function run (url: string): { queue: ReturnType<typeof vi.fn>, prevented: () => boolean } {
  const queue = vi.fn()
  let prevented = false
  handleOpenUrl({ preventDefault: () => { prevented = true } }, url, queue)
  return { queue, prevented: () => prevented }
}

describe('a link handed to a running macOS app', () => {
  it('queues an http or https address as the address a second launch would carry, and claims the event', () => {
    const { queue, prevented } = run('https://Example.com/a?b=c')
    expect(queue).toHaveBeenCalledWith(['https://example.com/a?b=c'])
    expect(prevented()).toBe(true)
  })

  it('drops every other scheme, and an address that does not parse, without queueing anything', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'orivon://settings', 'data:text/html,x', 'mailto:a@b.c', 'https://', 'notes.txt', '--orivon-private']) {
      const { queue } = run(url)
      expect(queue, url).not.toHaveBeenCalled()
    }
  })

  it('still claims an event it dropped, so the system does not offer it elsewhere', () => {
    expect(run('file:///etc/passwd').prevented()).toBe(true)
  })
})
