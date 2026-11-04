# ADR-0105: WebGPU on an X11 session is an opt-in setting that composites through Vulkan and turns itself off after a bad run

- **Status:** accepted. Carries out `d-0758`.
- **Date:** 2026-11-04
- **Type:** product / architecture
- **Decided by:** owner (an opt-in setting for X11, off by default, and its wording); AI recommendation accepted by default for the guard and the switches, marked *provisional* below where it is not measured

## Decision

**A setting, `graphics.webgpuOnX11`, off by default, makes Orivon composite through Vulkan when Chromium runs on Ozone X11.** When the saved setting is on, the main process sets `--use-angle=vulkan` and adds `Vulkan` and `VulkanFromANGLE` to the features it already lists (`--enable-features` is merged, never replaced), before Chromium reads its switches. `Vulkan` is what makes a WebGPU adapter appear; `VulkanFromANGLE` keeps WebGL working beside it. The setting is read once, at the start, so a change needs a new start of Orivon; Settings says so and offers the restart.

**Where the switches apply, and where the row is shown, are two questions.** The switches apply wherever Chromium draws through Ozone X11 on Linux: Chromium's own choice is read from the command line, or is Wayland on a Wayland session and X11 otherwise. Settings shows the row only on an X11 session (Ozone X11 and a session that is not Wayland), because Orivon on X11 inside a Wayland session (XWayland) is a path a person reaches by forcing it, and there the right answer is Orivon's own Wayland path. A profile that has the setting on keeps it applied on either.

**A guard turns the setting off by itself, at once, when a run that applied the switches went wrong.** Three things count:
- the graphics process ended in a way the diagnostics count as a problem (the same list as the crash counter, so Orivon quitting or the system reclaiming memory does not);
- ten seconds after the first window is shown, Chromium still draws pages on the processor (`gpu_compositing` is not enabled), which is how a graphics process that cannot start with the switches looks: it exits and starts again until Chromium gives up, without any end of a process being reported;
- a run that set the switches never showed its first window (a start marker the profile keeps from before Chromium reads its switches until that window shows; found still set at the next start).

Each saves the setting as off, and writes the time and which of the three it was to `x11-vulkan.json` in the profile. Settings and `orivon://gpu` say that Orivon turned it off, and a bug report carries the record. Turning the setting on again forgets the record. A private window follows the copy of the settings it started from and keeps its own record.

## Context

Chromium 152 gives WebGPU no adapter on X11 for any graphics card: the bridge from Vulkan to GL, which the adapter needs, is set only by Ozone Wayland. Upstream turned it off on X11 as a temporary fix because creating a Vulkan device made the video decoder pick the integrated GPU, so video on an NVIDIA laptop composited blank. The owner asked for WebGPU on as many computers as possible (`d-0758`: an opt-in setting on X11, not on for every X11 user). [`webgpu-plan.md`](../planning/webgpu-plan.md) holds the measurements.

## Alternatives considered

- **Turn it on for every X11 user.** Rejected by the owner: it changes the compositor for every page of a person who never asked for WebGPU, on a stack upstream withdrew for a reason this build cannot rule out on every laptop.
- **Lift the bridge's blocklist entry instead of compositing through Vulkan.** Rejected: it keeps GL as the compositor and enables the bridge on X11 for every card, with the upstream video fault still there and no way to measure which cards it breaks.
- **`--enable-unsafe-webgpu`.** Rejected: it does not lift the blocklist entry, and it lets a page read GPU data of other Chromium processes.
- **Guard only on a graphics process that crashes.** Rejected: measured here, a Vulkan driver that cannot be loaded makes the graphics process exit during start-up and start again until Chromium falls back to drawing on the processor, without a crash being reported; the person would be left with software drawing in every tab and the setting still on.
- **Guard at the next start only.** Rejected: a person who turns the setting on and sees pages go wrong needs it off as soon as it is known, and the next start may be days away.

## Reasoning

A setting that changes what every page is drawn with must come with a way back that needs no knowledge of the setting. Reading the setting before Chromium reads its switches, and turning it off in the saved file before anything else reads it at the next start, keeps a bad run from repeating. The start marker covers the case no event reports: a run that applied the switches and never got as far as a window. The processor-drawing check covers the one that exits without a crash. The Ozone rule mirrors Chromium's own choice (an explicit `--ozone-platform` wins; otherwise Wayland on a Wayland session), because Chromium resolves it before the main process starts and the setting must apply exactly where Chromium chose X11.

## Consequences

- On a laptop with two graphics cards, Vulkan picks the stronger one, so battery drains faster, and on some such laptops videos can show a blank picture. Both are said in the setting's help.
- The guard can turn the setting off on a computer where the setting is on and the graphics process was already drawing on the processor before it was on (a virtual machine, a driver on Chromium's blocklist). That is intended: the switches gave nothing there.
- A profile now holds one more small file, `x11-vulkan.json`; a profile that never turns the setting on never has it written.
- **Provisional: real Xorg is not measured.** The setting was measured under a virtual X server and under Xwayland on this build, with an NVIDIA and an Intel graphics card each: an adapter, a compute shader, a WebGPU canvas read back from the X server's screen, WebGL, painting, scrolling and two videos, with no graphics process ended. Whether hardware video decoding picks the integrated card on a real Xorg session with an NVIDIA hybrid laptop, which is the fault upstream names, is not measured. What would settle it: a person on Xorg with such a laptop turning the setting on and reporting through `orivon://report`.
- **Provisional: ten seconds.** The processor-drawing check looks ten seconds after the first window; a computer slow enough that the graphics process is still starting then would be reverted without cause. What would settle it: a report whose record says it turned itself off while pages drew through Vulkan.
- The setting is retired when Chromium turns the bridge back on under X11. Each Electron update checks for it.

## Reversibility

- **Cost to reverse:** cheap. One setting, one small module (`src/main/graphics/`), one Settings part and one profile file.
- **What would make us revisit:** a Chromium that gives X11 a WebGPU adapter by default, or the two provisional notes above settling the other way.
