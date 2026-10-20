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

  it('queues the address an orivon:open link names, with the flavour it carries', () => {
    const plain = run('orivon:open?u=vitalik.eth/a')
    expect(plain.queue).toHaveBeenCalledWith(['https://vitalik.eth/a'])
    expect(plain.prevented()).toBe(true)
    expect(run('orivon://open?u=ipns://docs.ipfs.tech&flavour=freetube').queue).toHaveBeenCalledWith(['https://ipns.orivon/docs.ipfs.tech/'], 'freetube')
  })

  it('drops an orivon: link that names anything else, and still claims the event', () => {
    for (const url of ['orivon:open?u=https://example.com', 'orivon:open?u=file:///etc/passwd', 'orivon:open?u=javascript:alert(1)', 'orivon:open', 'orivon:open?u=vitalik.eth/..', 'orivon:open?u=orivon://settings']) {
      const { queue, prevented } = run(url)
      expect(queue, url).not.toHaveBeenCalled()
      expect(prevented(), url).toBe(true)
    }
  })

  it('still claims an event it dropped, so the system does not offer it elsewhere', () => {
    expect(run('file:///etc/passwd').prevented()).toBe(true)
  })
})
