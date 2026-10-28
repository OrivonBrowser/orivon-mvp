import { describe, expect, it } from 'vitest'
import { isInternetHost, serverAddressProblem } from '../server-address.js'

const execution = (text: string): string | undefined => serverAddressProblem(text, 'execution')
const beacon = (text: string): string | undefined => serverAddressProblem(text, 'beacon')

describe('serverAddressProblem: an address on the internet', () => {
  it('takes https on the usual port, with a path or a query that holds a key', () => {
    for (const text of ['https://eth.drpc.org', 'https://mainnet.infura.io/v3/FAKE-KEY-0123456789', 'https://lb.drpc.org/ogrpc?network=ethereum&dkey=FAKE-KEY', 'https://rpc.example:443/', 'https://8.8.8.8/']) {
      expect(execution(text), text).toBeUndefined()
    }
  })

  it('refuses http, because the key would travel in clear', () => {
    expect(execution('http://rpc.example.com/')).toMatch(/https/)
  })

  it('refuses any port but 443, which is the only one the light client dials outside the tunnel', () => {
    expect(execution('https://rpc.example.com:8545/')).toMatch(/port/)
  })

  it('refuses a name no public server answers to, and every protocol host', () => {
    for (const text of ['https://vitalik.eth/', 'https://node/', 'https://nas.local/', 'https://printer.home.arpa/', 'https://foo.localhost/', 'https://direct-execution.orivon.invalid/', 'https://rpc.example.com./']) {
      expect(execution(text), text).toMatch(/not a server on the internet/)
    }
  })

  it('refuses an address that is neither this computer, a home network nor the internet', () => {
    for (const text of ['https://169.254.169.254/', 'http://169.254.1.1:8545/', 'https://224.0.0.1/', 'https://0.0.0.0/', 'http://[fe80::1]:8545/', 'https://100.64.0.1/', 'http://[::ffff:7f00:1]:8545/']) {
      expect(execution(text), text).toMatch(/not an address on this computer, a home network or the internet/)
    }
  })
})

describe('serverAddressProblem: a server on this computer or the home network', () => {
  it('takes http or https, any port, at localhost, a loopback literal or a private one', () => {
    for (const text of ['http://localhost:8545', 'http://127.0.0.1:8545/v3/FAKE-KEY', 'http://[::1]:8545', 'http://192.168.1.20:8545', 'http://10.0.0.5:8545/', 'https://172.16.4.2:8546/', 'http://[fd00::5]:8545/', 'http://127.0.0.1']) {
      expect(execution(text), text).toBeUndefined()
    }
  })

  it('reads a spelling of an address the way the network does, never as the name it looks like', () => {
    expect(execution('http://0x7f.1:8545/')).toBeUndefined()
    expect(execution('http://2130706433:8545/')).toBeUndefined()
    expect(execution('http://[::ffff:8.8.8.8]:8545/')).toMatch(/https/)
  })

  it('refuses a name for a home computer over http, which a resolver could point elsewhere', () => {
    const problem = execution('http://dappnode.local:8545/')
    expect(problem).toMatch(/not a server on the internet/)
    expect(problem).toMatch(/192\.168/)
  })
})

describe('serverAddressProblem: what no address may hold', () => {
  it('refuses text that is not an address, with spaces, in a scheme that is not http or https, or too long', () => {
    for (const text of ['', 'rpc.example.com', 'not an address', 'ftp://rpc.example.com/', 'wss://rpc.example.com/', 'https://rpc.example.com/a b', `https://rpc.example.com/${'a'.repeat(2048)}`]) {
      expect(execution(text), text).toBeDefined()
    }
  })

  it('refuses a user name, a password and a fragment', () => {
    expect(execution('https://user:pass@rpc.example.com/')).toMatch(/user name/)
    expect(execution('https://user@rpc.example.com/')).toMatch(/user name/)
    expect(execution('https://rpc.example.com/#key')).toMatch(/#/)
  })

  it('never repeats the address it refuses', () => {
    for (const text of ['https://user:SECRETVALUE@rpc.example.com/', 'http://rpc.example.com/SECRETVALUE', 'https://rpc.example.com:8545/SECRETVALUE', 'https://node/SECRETVALUE', 'SECRETVALUE']) {
      expect(execution(text) ?? '', text).not.toContain('SECRETVALUE')
    }
  })
})

describe('serverAddressProblem: a beacon server', () => {
  it('holds a path and no query, because the light client adds its own paths after it', () => {
    expect(beacon('https://beacon.example.com/prefix')).toBeUndefined()
    expect(beacon('http://127.0.0.1:5052')).toBeUndefined()
    expect(beacon('https://beacon.example.com/?key=FAKE')).toMatch(/\?/)
  })

  it('may keep a query in an execution server, where a provider puts its key', () => {
    expect(execution('https://beacon.example.com/?key=FAKE')).toBeUndefined()
  })
})

describe('isInternetHost', () => {
  it('takes a public name and a public address literal', () => {
    for (const host of ['eth.drpc.org', 'mainnet.infura.io', '8.8.8.8', '[2606:4700:4700::1111]']) expect(isInternetHost(host), host).toBe(true)
  })

  it('refuses a name that can never resolve', () => {
    expect(isInternetHost('direct-execution.orivon.invalid')).toBe(false)
  })

  it('judges a name as a name: one that resolves to this computer cannot be told from the spelling and is taken (T12 residual)', () => {
    for (const host of ['127.0.0.1.nip.io', 'localtest.me']) expect(isInternetHost(host), host).toBe(true)
  })
})
