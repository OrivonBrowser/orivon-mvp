---
name: block-x-server-that-takes-the-owners-display
enabled: true
event: bash
pattern: \b(?:gnome-shell|mutter)\b(?=[^\n]*--(?:headless|wayland|nested|virtual-monitor))(?![^\n]*--no-x11)|\b(?:Xwayland|Xvfb|Xephyr|Xorg)\s+:[0-9]\b
action: block
---

**Blocked: this X or GNOME launch can take over the owner's display.**

The owner's desktop is an X11 session. A command inside the heavy gate, or any sandbox with its own
network namespace, cannot see that display's abstract socket, so an X server started there takes the
low display numbers as free. It writes over the owner's files in `/tmp/.X11-unix/` and the
`/tmp/.X<n>-lock` files. Apps that connect by that path then cannot open a window until the owner
logs in again.

- A headless GNOME or mutter session always gets `--no-x11`, so it starts no Xwayland of its own.
- For X11, start a standalone `Xwayland` or `Xvfb` on a display number of two digits or more, such
  as `:77`. `xvfb-run -a` and `scripts/run-headless.mjs` already pick free high numbers.
