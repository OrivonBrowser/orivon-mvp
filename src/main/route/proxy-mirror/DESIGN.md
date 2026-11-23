# `src/main/route/proxy-mirror/`: why it has this shape

Read only when changing a decision here; [`README.md`](README.md) is the map.

**The first read starts before the browser is ready, and the first pass takes it.** A read waits on a program (or a file) and needs no
session, so the route subsystem starts it in its `beforeReady` hook (`early-read.ts`), while Chromium initialises, and the first pass
awaits that read where it would have started one. A pass that comes while it is in flight waits for it (the 3 seconds of
`READ_TIMEOUT_MS` run from its start), one that comes after it ended finds it done, and every later read, the second attempt of a pass
included, starts its own. Which reader runs, its time limit and what a failed or slow read comes to are the same as for a read made after
ready: the settings source is a function of the platform and the environment alone. A window held to a tunnel (read from the command line,
since the launch context does not exist yet) starts none, as it reads none later. A first pass may therefore act on settings a few
seconds old; a copy that disagrees with Chromium's own answer is read again at once, as in any pass.

What the early read saves is the read itself (about 20 to 30 ms on Windows and macOS runners, where three `reg.exe` or one `scutil` run
before the first check), not the first pass: on a first start the pass waits some 500 ms for Chromium's own first answer about a proxy
(the question `sample` asks the session that follows the system), which arrives at about the same time since the process began whether
it is asked at the end of `afterReady` or in `afterWindow`, and takes 25 to 35 ms at the next start. Starting the pass earlier did not
shorten the hook (measured on a Windows runner).

**Windows reads three keys, not one recursive query.** `reg query <key> /s` would cover the Internet Settings key and its `Connections`
subkey in one process, but it printed 235 lines over 36 keys on a clean runner and took 150 to 165 ms where the three queries together
take 21 to 32 ms, run side by side; the machine policy is another hive and needs its own query anyway; and the output is unbounded
(the zone lists of a managed computer), where a read that prints over a megabyte is a read that failed.

**An unchanged read does nothing.** The settings and Chromium's two base answers are compared with the last pass; only a difference, or a
state that is not settled (`unreadable`, `disagrees`), runs the check again. The 2-second question is asked in process of the session
that only follows the system: it costs no process and no network for fixed rules.
