// A real tokio program, built for wasm32-wasip2, run against the host: an
// event loop over mio reaches the host through wasi-libc's non-blocking
// sockets and poll, many pollables at once, which a blocking std program
// never does. The program is built outside this repository (ADR-0002), so
// this runs only when ORIVON_WASIP2_TOKIO_PROGRAM names the built .wasm and
// ORIVON_JCO_DIR names jco (support/jco.ts). A crate named `tokiocheck`,
// depending on tokio 1 with features rt, macros, net, time and io-util, and
// this src/main.rs:
//
//   use std::time::{Duration, Instant};
//   use tokio::io::{AsyncReadExt, AsyncWriteExt};
//   use tokio::net::{TcpListener, TcpStream, UdpSocket};
//   async fn echo_once(target: &str, message: &str) -> String {
//     let mut stream = TcpStream::connect(target).await.unwrap(); stream.write_all(message.as_bytes()).await.unwrap();
//     let mut buf = vec![0u8; 64]; let n = stream.read(&mut buf).await.unwrap(); String::from_utf8_lossy(&buf[..n]).into_owned()
//   }
//   #[tokio::main(flavor = "current_thread")]
//   async fn main() {
//     let args: Vec<String> = std::env::args().collect();
//     let target = args.get(2).cloned().unwrap_or_default();
//     match args.get(1).map(String::as_str) {
//       Some("connect") => { let (a, b) = tokio::join!(echo_once(&target, "first\n"), echo_once(&target, "second\n")); print!("{}{}", a, b); }
//       Some("listen") => {
//         let listener = TcpListener::bind(&target).await.unwrap();
//         println!("listening on {}", listener.local_addr().unwrap().port());
//         let mut tasks = Vec::new();
//         for _ in 0..2 {
//           let (mut conn, _) = listener.accept().await.unwrap();
//           tasks.push(tokio::spawn(async move { let mut buf = vec![0u8; 64]; let n = conn.read(&mut buf).await.unwrap();
//             conn.write_all(&buf[..n]).await.unwrap(); String::from_utf8_lossy(&buf[..n]).into_owned() }));
//         }
//         let mut got = Vec::new(); for task in tasks { got.push(task.await.unwrap()); } got.sort(); print!("{}", got.concat());
//       }
//       Some("udp") => {
//         let socket = UdpSocket::bind("0.0.0.0:0").await.unwrap(); socket.send_to(b"udp hello", &target).await.unwrap();
//         let mut buf = [0u8; 64]; let (n, from) = socket.recv_from(&mut buf).await.unwrap();
//         println!("{} from {} on {}", String::from_utf8_lossy(&buf[..n]), from, socket.local_addr().unwrap().port());
//       }
//       Some("timers") => {
//         let start = Instant::now(); tokio::time::sleep(Duration::from_millis(30)).await;
//         let raced = tokio::select! { _ = tokio::time::sleep(Duration::from_millis(20)) => "short", _ = tokio::time::sleep(Duration::from_secs(5)) => "long" };
//         let timed_out = tokio::time::timeout(Duration::from_millis(10), std::future::pending::<()>()).await.is_err();
//         println!("{} {} {}", raced, timed_out, start.elapsed() >= Duration::from_millis(50));
//       }
//       _ => std::process::exit(2),
//     }
//   }
//
//   RUSTFLAGS="--cfg tokio_unstable" cargo build --release --target wasm32-wasip2
//   ORIVON_WASIP2_TOKIO_PROGRAM=target/wasm32-wasip2/release/tokiocheck.wasm ORIVON_JCO_DIR=<jco> npx vitest run src/shim/wasi-p2/tests/tokio-program.test.ts
//
// tokio refuses its `net` feature on WebAssembly without `tokio_unstable`.
// Last run with Rust 1.98.1, tokio 1.53.1 and mio 1.2.3: every mode passes.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { createFakeTcpServer } from '../../tests/support/fake-tcp-server.js'
import { createFakeTcpSocket } from '../../tests/support/fake-tcp-socket.js'
import { createFakeUdpSocket } from '../../tests/support/fake-udp-socket.js'
import { hasJspi } from '../../wasi/tests/support/jspi.js'
import type { SocketNet } from '../addresses.js'
import { JCO_DIR, type Transpiled } from './support/jco.js'
import { netWith, runProgram, transpileProgram } from './support/real-program.js'

const PROGRAM = process.env.ORIVON_WASIP2_TOKIO_PROGRAM

let program: Transpiled

async function run (mode: string, target: string, net: SocketNet): Promise<{ code: number, stdout: string }> {
  return await runProgram(program, 'tokiocheck', mode, target, net)
}

describe.skipIf(PROGRAM === undefined || JCO_DIR === undefined || !hasJspi)('a tokio program, wasm32-wasip2', () => {
  beforeAll(async () => {
    program = await transpileProgram(PROGRAM as string, 'tokiocheck')
  })

  it('sleeps, races two timers and times out a future that never completes', async () => {
    expect(await run('timers', '', netWith({}))).toEqual({ code: 0, stdout: 'short true true\n' })
  })

  it('connects twice at once and reads each echo back', async () => {
    const peers: Array<ReturnType<typeof createFakeTcpSocket>> = []
    const echo = setInterval(() => { for (const peer of peers) { const sent = peer.written.shift(); if (sent !== undefined) peer.push(sent) } }, 1)
    const connect = async (): Promise<never> => {
      const peer = createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: 7000 })
      peers.push(peer)
      return peer.socket as never
    }
    try {
      expect(await run('connect', '127.0.0.1:7000', netWith({ connect }))).toEqual({ code: 0, stdout: 'first\nsecond\n' })
      expect(peers).toHaveLength(2)
    } finally {
      clearInterval(echo)
    }
  })

  it('listens on the port orivon.net chose, and serves two connections at once', async () => {
    const server = createFakeTcpServer({ localAddress: '127.0.0.1', localPort: 7001 })
    const listen = vi.fn(async () => server.server)
    const [first, second] = [50_001, 50_002].map((port) => createFakeTcpSocket({ remoteAddress: '127.0.0.1', remotePort: port }))
    if (first === undefined || second === undefined) throw new Error('two peers')
    const running = run('listen', '127.0.0.1:0', netWith({ listen }))
    await vi.waitFor(() => { expect(server.pullCount()).toBeGreaterThan(0) })
    server.deliver(first.socket)
    server.deliver(second.socket)
    second.push(new TextEncoder().encode('b\n'))
    first.push(new TextEncoder().encode('a\n'))
    expect(await running).toEqual({ code: 0, stdout: 'listening on 7001\na\nb\n' })
    expect(listen).toHaveBeenCalledWith({ port: 0, scope: 'local' })
    expect(new TextDecoder().decode(first.written[0])).toBe('a\n')
  })

  it('binds a UDP socket to the port orivon.net chose, sends and receives', async () => {
    const fake = createFakeUdpSocket({ localAddress: '0.0.0.0', localPort: 7002 })
    const echo = setInterval(() => { const datagram = fake.sent.shift(); if (datagram !== undefined) fake.deliver({ ...datagram, address: '127.0.0.1', port: 7003, family: 'IPv4' }) }, 1)
    try {
      expect(await run('udp', '127.0.0.1:7003', netWith({ udpBind: async () => fake.socket }))).toEqual({ code: 0, stdout: 'udp hello from 127.0.0.1:7003 on 7002\n' })
    } finally {
      clearInterval(echo)
    }
  })
})
