// A real Rust standard-library program, built for wasm32-wasip2, run against
// the host: std's files, TCP, name lookup and UDP reach it through
// wasi-libc exactly as a ported program's would, which the hand-assembled
// fixtures cannot show. The program is built outside this repository
// (ADR-0002), so this runs only when ORIVON_WASIP2_STD_PROGRAM names the
// built .wasm and ORIVON_JCO_DIR names jco (support/jco.ts). The program,
// as src/main.rs of a crate named `netcheck`:
//
//   use std::io::{Read, Write};
//   use std::net::{TcpListener, TcpStream, ToSocketAddrs, UdpSocket};
//   fn main() {
//     let args: Vec<String> = std::env::args().collect();
//     let target = args.get(2).cloned().unwrap_or_default();
//     let mut buf = [0u8; 64];
//     match args.get(1).map(String::as_str) {
//       Some("connect") => { let mut s = TcpStream::connect(&target).unwrap(); s.write_all(b"hello from rust\n").unwrap();
//         let n = s.read(&mut buf).unwrap(); print!("{}", String::from_utf8_lossy(&buf[..n])) }
//       Some("resolve") => for a in (target.as_str(), 443).to_socket_addrs().unwrap() { println!("{}", a.ip()) },
//       Some("listen") => { let l = TcpListener::bind(&target).unwrap(); println!("listening"); let (mut c, _) = l.accept().unwrap();
//         let n = c.read(&mut buf).unwrap(); c.write_all(&buf[..n]).unwrap(); print!("{}", String::from_utf8_lossy(&buf[..n])) }
//       Some("udp") => { let s = UdpSocket::bind("0.0.0.0:0").unwrap(); s.send_to(b"udp hello", &target).unwrap();
//         let (n, from) = s.recv_from(&mut buf).unwrap(); println!("{} from {}", String::from_utf8_lossy(&buf[..n]), from) }
//       Some("files") => { std::fs::create_dir_all("data/nested").unwrap(); std::fs::write("data/nested/note.txt", b"written by rust").unwrap();
//         let read = std::fs::read_to_string("data/nested/note.txt").unwrap();
//         let names: Vec<String> = std::fs::read_dir("data/nested").unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
//         println!("{} {:?}", read, names) }
//       _ => std::process::exit(2),
//     }
//   }
//
//   cargo build --release --target wasm32-wasip2
//   ORIVON_WASIP2_STD_PROGRAM=target/wasm32-wasip2/release/netcheck.wasm ORIVON_JCO_DIR=<jco> npx vitest run src/shim/wasi-p2/tests/std-program.test.ts
//
// Last run with Rust 1.98.1: every mode passes.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createFakeTcpServer } from '../../tests/support/fake-tcp-server.js'
import { createFakeTcpSocket } from '../../tests/support/fake-tcp-socket.js'
import { createFakeUdpSocket } from '../../tests/support/fake-udp-socket.js'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { hasJspi } from '../../wasi/tests/support/jspi.js'
import type { SocketNet } from '../addresses.js'
import { JCO_DIR, type Transpiled } from './support/jco.js'
import { netWith, runProgram, transpileProgram } from './support/real-program.js'

const PROGRAM = process.env.ORIVON_WASIP2_STD_PROGRAM

let program: Transpiled

async function run (mode: string, target: string, net: SocketNet, fs?: unknown): Promise<{ code: number, stdout: string }> {
  return await runProgram(program, 'netcheck', mode, target, net, fs)
}

describe.skipIf(PROGRAM === undefined || JCO_DIR === undefined || !hasJspi)('a Rust standard-library program, wasm32-wasip2', () => {
  beforeAll(async () => {
    program = await transpileProgram(PROGRAM as string, 'netcheck')
  })

  it('creates, writes, reads and lists files through orivon.fs', async () => {
    const disk = await createRealDiskFs()
    try {
      expect(await run('files', '', netWith({}), disk.orivon.fs)).toEqual({ code: 0, stdout: 'written by rust ["note.txt"]\n' })
    } finally {
      await disk.cleanup()
    }
  })

  it('connects, writes and reads over TCP', async () => {
    const fake = createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: 7000 })
    const echo = setInterval(() => { const sent = fake.written.shift(); if (sent !== undefined) fake.push(sent) }, 1)
    try {
      expect(await run('connect', '127.0.0.1:7000', netWith({ connect: async () => fake.socket }))).toEqual({ code: 0, stdout: 'hello from rust\n' })
    } finally {
      clearInterval(echo)
    }
  })

  it('resolves a name to both families', async () => {
    const lookup = async (): Promise<Array<{ address: string, family: 'IPv4' | 'IPv6' }>> => [{ address: '93.184.216.34', family: 'IPv4' }, { address: '2606:2800:220:1:248:1893:25c8:1946', family: 'IPv6' }]
    expect(await run('resolve', 'example.test', netWith({ lookup }))).toEqual({ code: 0, stdout: '93.184.216.34\n2606:2800:220:1:248:1893:25c8:1946\n' })
  })

  it('listens, accepts and echoes a connection', async () => {
    const server = createFakeTcpServer({ localAddress: '127.0.0.1', localPort: 7001 })
    const peer = createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: 50_001 })
    const running = run('listen', '127.0.0.1:7001', netWith({ listen: async () => server.server }))
    await vi.waitFor(() => { expect(server.pullCount()).toBeGreaterThan(0) })
    server.deliver(peer.socket)
    peer.push(new TextEncoder().encode('rust listener echo\n'))
    expect(await running).toEqual({ code: 0, stdout: 'listening\nrust listener echo\n' })
    expect(new TextDecoder().decode(peer.written[0])).toBe('rust listener echo\n')
  })

  it('sends and receives a UDP datagram', async () => {
    const fake = createFakeUdpSocket({ localAddress: '0.0.0.0', localPort: 7002 })
    const echo = setInterval(() => { const datagram = fake.sent.shift(); if (datagram !== undefined) fake.deliver({ ...datagram, address: '127.0.0.1', port: 7003, family: 'IPv4' }) }, 1)
    try {
      expect(await run('udp', '127.0.0.1:7003', netWith({ udpBind: async () => fake.socket }))).toEqual({ code: 0, stdout: 'udp hello from 127.0.0.1:7003\n' })
    } finally {
      clearInterval(echo)
    }
  })
})
