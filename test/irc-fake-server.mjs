// A minimal IRC server for end-to-end tests, on `node:net`: enough of RFC 1459/2812 for a real
// client to register, join a channel, exchange messages and answer its keep-alive. It records
// every line it receives, and can speak as another nick.
//
//   const irc = await startFakeIrc(6667)
//   irc.lines            every line received from clients, in order
//   irc.privmsgs()       the PRIVMSG lines only
//   irc.say('bob', '#orivon', 'hello')   a PRIVMSG from another nick to every connected client
//   await irc.close()

import { createServer } from 'node:net'

/**
 * @param {number} port
 * @param {string} [host]
 * @returns {Promise<{
 *   lines: string[],
 *   clients: () => number,
 *   privmsgs: () => string[],
 *   say: (nick: string, target: string, text: string) => void,
 *   raw: (line: string) => void,
 *   close: () => Promise<void>
 * }>}
 */
export async function startFakeIrc (port, host = '127.0.0.1') {
  /** @type {string[]} */
  const lines = []
  /** @type {Set<import('node:net').Socket>} */
  const sockets = new Set()

  const server = createServer((socket) => {
    sockets.add(socket)
    let nick = ''
    let user = false
    let registered = false
    let buffer = ''
    const send = (/** @type {string} */ line) => { if (!socket.destroyed) socket.write(`${line}\r\n`) }
    socket.on('close', () => { sockets.delete(socket) })
    socket.on('error', () => {})
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      for (;;) {
        const end = buffer.indexOf('\r\n')
        if (end < 0) break
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        lines.push(line)
        const [command = '', ...rest] = line.split(' ')
        switch (command.toUpperCase()) {
          case 'CAP':
            if (rest[0] === 'LS') send(':irc.test CAP * LS :')
            break
          case 'NICK': nick = rest[0] ?? nick; break
          case 'USER': user = true; break
          case 'PING': send(`:irc.test PONG irc.test ${rest[0] ?? ''}`); break
          case 'JOIN': {
            const channel = (rest[0] ?? '').replace(/^:/, '')
            send(`:${nick}!u@orivon.test JOIN ${channel}`)
            send(`:irc.test 353 ${nick} = ${channel} :${nick} @op`)
            send(`:irc.test 366 ${nick} ${channel} :End of /NAMES list.`)
            break
          }
          case 'QUIT': socket.end(); break
          default: break
        }
        if (!registered && nick !== '' && user) {
          registered = true
          send(`:irc.test 001 ${nick} :Welcome to the test network ${nick}`)
          send(`:irc.test 002 ${nick} :Your host is irc.test`)
          send(`:irc.test 003 ${nick} :This server was created today`)
          send(`:irc.test 004 ${nick} irc.test fake-1.0 o o`)
          send(`:irc.test 005 ${nick} CHANTYPES=# NETWORK=OrivonTest :are supported by this server`)
          send(`:irc.test 375 ${nick} :- irc.test message of the day -`)
          send(`:irc.test 372 ${nick} :- Welcome.`)
          send(`:irc.test 376 ${nick} :End of /MOTD command.`)
        }
      }
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve(undefined) })
  })

  return {
    lines,
    clients: () => sockets.size,
    privmsgs: () => lines.filter((line) => line.startsWith('PRIVMSG ')),
    say (nick, target, text) {
      for (const socket of sockets) socket.write(`:${nick}!${nick}@orivon.test PRIVMSG ${target} :${text}\r\n`)
    },
    raw (line) {
      for (const socket of sockets) socket.write(`${line}\r\n`)
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => { server.close(() => { resolve(undefined) }) })
    }
  }
}
