import { describe, expect, it } from 'vitest'
import type { Broker } from '../../../broker/broker-contracts.js'
import { APP_TAB_FLAG, appTabArgsFor } from '../tab-partition.js'

const brokerWith = (...registered: string[]): Broker => ({ app: { isRegisteredSync: (origin: string) => registered.includes(origin) } }) as unknown as Broker

describe('appTabArgsFor', () => {
  it('flags a web origin the broker has registered', () => {
    expect(appTabArgsFor('https://app.example/x', brokerWith('https://app.example'))).toEqual([APP_TAB_FLAG])
    expect(appTabArgsFor('https://other.example/', brokerWith('https://app.example'))).toBeUndefined()
  })

  it('flags a local file by its key, query and fragment aside, once the broker has registered that exact file', () => {
    const broker = brokerWith('file:///home/u/notes/app.html')
    expect(appTabArgsFor('file:///home/u/notes/app.html?x=1#top', broker)).toEqual([APP_TAB_FLAG])
    expect(appTabArgsFor('file:///home/u/notes/other.html', broker)).toBeUndefined()
  })

  it('flags nothing for a file with a host, or with no broker', () => {
    expect(appTabArgsFor('file://nas/share/app.html', brokerWith('file://nas/share/app.html'))).toBeUndefined()
    expect(appTabArgsFor('file:///home/u/notes/app.html', undefined)).toBeUndefined()
  })
})
