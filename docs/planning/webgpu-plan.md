# WebGPU on as many computers as possible: plan

**Need.** The owner asked for WebGPU on as many computers as possible. Two kinds of users rely on it:
- local-model apps, ported to `@mlc-ai/web-llm` or to the WebGPU backends of `onnxruntime-web` and `@tensorflow/tfjs`
  ([Table 5](compatibility/table-5-native-modules.md));
- websites that require WebGPU.

**Decisions.** `d-0757` (Wayland, one GPU maker at a time), `d-0758` (X11, an opt-in setting) and `d-0759` (no CPU
fallback).

## Where WebGPU stands in this build

Orivon sets no GPU switch, so it runs Chromium 152's defaults (Electron 44.7.0, Chromium 152.0.7977.130). Step 1
measured what a page gets, with a probe page that asks `requestAdapter()` and reads one compute dispatch back, on this
machine (an Intel Tiger Lake GPU on Mesa 25 and an NVIDIA RTX 3050 on driver 595.99.02, a hybrid laptop) and on
GitHub's Windows and macOS runners. Rows marked *source* were read from Chromium's source at that tag and not run.

| Where | WebGPU by default | How known |
|---|---|---|
| macOS 13 and later | On, through Metal. The runner's virtual Apple GPU gives an adapter (vendor `apple`) and a compute dispatch reads back; `gpu_compositing` is `enabled` | measured on the runner; a Mac with real GPUs *source* |
| Windows with a GPU | On, through D3D12, for AMD, Intel, NVIDIA and, with recent drivers, Qualcomm. Other GPU makers are refused by Dawn's adapter blocklist | *source* |
| Windows with no GPU (a runner, a virtual machine) | Off. The only adapter is Microsoft's Basic Render Driver (WARP); Chromium composites in software (`gpu_compositing` is `disabled_software`), reports `webgpu` as `unavailable_software`, and a page gets no WebGL and no adapter | measured on the runner |
| Linux, Wayland | Off on this machine, though Chromium reports it on: `webgpu` and `webgpu_on_vk_via_gl_interop` read `enabled`, `requestAdapter()` returns null (console: "No available adapters."), in all 7 runs that did not crash (the default, the Intel render node, each Vulkan driver alone, Mesa's software Vulkan). WebGL, compositing and video work on the Intel GPU. Whether a computer with one GPU gets an adapter through the exceptions below is not measured: this machine has two | measured |
| Linux, X11 on a real GPU (Xwayland) | Off: WebGL works on Intel through Mesa, the page paints, video plays, `requestAdapter()` returns null | measured |
| Linux, X11 on a virtual display with no GL (xvfb, the CI runners) | Off: the GPU process cannot start, compositing is software and `webgl` is `disabled_off` | measured |
| No usable GPU | Off, on every system | measured on Linux and Windows runners |

What the measurements corrected in the first reading of the source:
- **A status that reads "enabled" is not an adapter.** On Wayland the browser reports both `webgpu` and the bridge as
  `enabled` while a page gets none. On X11, `--use-angle=vulkan` alone makes the bridge read `enabled` and gives no
  adapter either. `orivon://gpu` and the bug report (step 2) must test the adapter itself (a page-side or GPU-process
  fact), never only these two words.
- **WARP is not offered.** The first reading expected WebGPU through WARP on a Windows computer with no GPU.
- **Wayland needs more than the exceptions on this machine.** `--ignore-gpu-blocklist=186` alone gives an adapter
  (NVIDIA Ampere; Intel Gen12 when Vulkan is limited to Intel's ICD, `VK_ICD_FILENAMES=.../intel_icd.json`),
  `compute` reads back and WebGL stays on Intel (5 of 5 runs where Chromium picked its own GPU). So entry 186 is what refuses the real
  GPUs here, and the exceptions below did not apply to this hybrid laptop.
- **The switch's value is a list of entry ids**, as the source says: `ParseGpuPreferences` reads a comma-separated list
  from `--ignore-gpu-blocklist=<ids>` and ignores exactly those entries; with no value it ignores the whole list.

Why Linux is narrow (from the source, still the reading the measurements agree with):
- The WebGPU service is on by default in the code (`kWebGPUService`, `gpu/config/gpu_finch_features.cc`), not through a
  field trial. Electron, which has no field trials, gets it.
- The adapter needs Vulkan, and Linux composites with GL. The bridge between them is the GPU feature
  `webgpu_on_vk_via_gl_interop`. Without it the backend is `Null` (`webgpu_decoder_impl.cc`).
- The bridge is set by Ozone Wayland (`ozone_platform_wayland.cc`). Upstream turned it off on X11 as a temporary
  fix: on X11, creating a Vulkan device made the video decoder pick the integrated GPU, so video on an NVIDIA GPU
  composited blank (crbug 500609035).
- Blocklist entry 186 (`gpu/config/software_rendering_list.json`) refuses the bridge everywhere except two exceptions:
  - Intel: GPU generation 12 or later, driver vendor Mesa, Mesa 22.0 or later;
  - NVIDIA: driver 535.183.01 or later.
- `--enable-unsafe-webgpu` does not lift entry 186: on Wayland it gave a SwiftShader adapter (a CPU adapter,
  `fallback: true`) and still none on the Intel or NVIDIA GPU. It turns off timestamp quantization and Dawn's adapter
  blocklist, which is what let the CPU adapter through, and exposes experimental features. Chrome warns that it lets a
  page read GPU data of other Chromium processes. Orivon never sets it.

## Step 1: measure, and pin what each platform gets

Done. What it found is in the section above; the rest of this section says what was run.

- **Probe** in a page:
  - `navigator.gpu`;
  - `requestAdapter()` and the adapter's `info`;
  - one compute dispatch read back;
  - `app.getGPUFeatureStatus()`, and the GPU process's crashes (`child-process-gone`);
  - for X11 candidates also a WebGL context, a painted page and two short videos (VP9 and H.264) whose `currentTime`
    advances, with pixels read back from the screen of the X server.
- **Where it ran:**
  - this machine, under a private headless GNOME Wayland session, under Xwayland inside it (a standalone Xwayland on a
    display number of its own; GNOME's built-in Xwayland takes the display numbers of a running desktop, so it is not
    run on a machine someone is using), and under xvfb;
  - GitHub's Windows and macOS runners, through `scripts/ci/cross-os.mjs`.
- **An e2e spec** (`test/page/e2e-webgpu.test.ts`) pins the result per platform on CI, so a Chromium update that changes
  it fails a check, not a user. It launches Orivon, so it pins what Orivon gets, not what bare Electron gets.
- **The compatibility-matrix row** "WebGL / WebGPU" carries the measured values.

## Step 2: say why WebGPU is off (Rule 24)

- **`orivon://gpu` gets a WebGPU section:**
  - whether a page gets an adapter, asked by a probe in the page that gives up after 10 seconds, and the adapter's vendor
    and architecture;
  - when there is none, the reason in plain words: an X11 session (or Orivon running through XWayland on a Wayland
    session), a GPU and driver Chromium gives no adapter on Linux because they are not on its list (said on Wayland once
    the page got none), pages drawn on the processor, WebGPU turned
    off, a GPU maker Dawn refuses on Windows, or an adapter the page was refused for no reason the report shows.
- **Not built:**
  - the adapter's backend: nothing this build reads states it, and one derived from the platform would be a claim this
    build never checks;
  - "no Vulkan driver": no field of the feature status or the basic GPU info is known to say whether a Vulkan driver is
    installed (`vulkan` is the compositing feature, which is off by default on Linux);
  - the X11 setting turned off after a crash, which arrives with step 3.
- **Durable:** working out the reason is a pure function over the platform, the desktop session, the Ozone platform, the
  GPU feature status and the GPU info (`src/main/diagnostics/webgpu-state.ts`). On Linux it decides by the Ozone
  platform: X11 is ruled out without a page, and on Wayland only a page that got no adapter says the GPU is not listed.
  It does not read `webgpu_on_vk_via_gl_interop`, which reads `enabled` on real GPUs under both where no adapter exists.
- **Tied to Electron:** reading those values.
- **Bug reports** from `orivon://report` carry the state and a reason code. The report page runs the same probe and
  sends its outcome with its request for the facts, so a report tells a working computer from one whose page got no
  adapter.

## Step 3: the X11 setting (`d-0758`)

Done. [`ADR-0105`](../decisions/ADR-0105-webgpu-on-an-x11-session-is-an-opt-in-setting-that-composites-through-vulkan-and-turns-itself-off-after-a-bad-run.md)
records the decision.

- **The setting:** `graphics.webgpuOnX11`, off by default, in Settings under Performance, group Graphics, shown only on
  an X11 session. It is read when Orivon starts, so turning it on shows a "Start again to apply" row with a "Restart
  Orivon" button. The switches apply wherever Chromium runs on Ozone X11, which includes XWayland.
- **What it does:** composite through Vulkan, so WebGPU needs no bridge. The set is
  `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE`, measured below.
- **What the measurements settled**, on the private Xwayland (a real X server with GL, so the closest to a desktop) and
  on xvfb, each cell one run, the four finalists repeated:

  | Switches | Xwayland | xvfb |
  |---|---|---|
  | none | no adapter; WebGL, painting and both videos work | software only: no WebGL, no adapter |
  | `--use-angle=vulkan` and `Vulkan,VulkanFromANGLE` | adapter, WebGL, painting, both videos | the same |
  | `Vulkan,VulkanFromANGLE,DefaultANGLEVulkan`, no `--use-angle` | the same | the same |
  | `--use-angle=vulkan` and all three features | the same | the same |
  | `--use-angle=vulkan` and `Vulkan,DefaultANGLEVulkan` | adapter, **no WebGL** | the same as the row above |
  | `--use-angle=vulkan` and `Vulkan` | adapter, **no WebGL** | the same as the row above |
  | `Vulkan` alone | adapter, WebGL (Intel GL), painting, videos | software only |
  | `--use-angle=vulkan` and `VulkanFromANGLE,DefaultANGLEVulkan`, or `--use-angle=vulkan` alone | **no adapter** (the bridge reads `enabled`) | no adapter |
  | `Vulkan,VulkanFromANGLE`, no `--use-angle` | no adapter | software only |

  The smallest set that gives an adapter and keeps painting, WebGL and both videos on both is the second row; the third
  works as well. The second names the ANGLE backend, which the third leaves to a feature that may be renamed. The
  `Vulkan` feature is what makes an adapter appear; `VulkanFromANGLE` is what keeps WebGL working with it.
- **Which GPU:** the Vulkan device is the NVIDIA one on this hybrid machine whatever `--render-node-override` says (the
  adapter, and the ANGLE renderer string, name the RTX 3050). Intel is reached only by limiting Vulkan to its driver
  (`VK_ICD_FILENAMES`, which is no Chromium switch): adapter vendor `intel`, architecture `gen-12lp`. Acceptance on
  "both GPUs" therefore runs with and without that variable, and the setting itself offers no GPU choice.
- **Crashes:** no `child-process-gone` event in any of the 38 runs under Xwayland and xvfb (28 of them with the `Vulkan`
  feature on). The warning in `src/main/index.ts` (ozone x11 segfaults the GPU process under XWayland on this machine) did
  not reproduce on a standalone Xwayland, with or without the set; GNOME's built-in Xwayland, the setup that warning
  describes, was not run (see step 1).
- **Video:** both videos play (`currentTime` advances; 0 to 16 frames dropped of 82 to 101 in the first 2.5 seconds) and the pixels read from the X
  server show the picture, not a blank, with the set on the NVIDIA Vulkan device. Whether the decoder is the NVIDIA
  one, which is upstream's reason for the block, is not measured: it needs a real X11 session (Xorg), which the
  acceptance below runs on.
- **A trap for the tests:** Playwright's Electron launcher replaces a command-line `--enable-features` with its own
  (`CDPScreenshotNewSurface`), so a spec cannot hand Orivon the features as launch arguments; they must be set by
  Orivon's main process, merged with what is already listed as `src/main/privacy/gpc-switch.ts` does. The same spec
  with the switches passed anyway shows `vulkan: disabled_off` and no adapter.
- **Crash guard:** the setting turns itself off, at once, and `x11-vulkan.json` in the profile keeps when and why,
  in three cases:
  - the graphics process ended badly in a run that set the switches (`gpu-crash`);
  - ten seconds after the first window, pages are still drawn on the processor (`gpu-software`): with no usable Vulkan
    driver the graphics process exits while it starts and starts again until Chromium gives up, and no end of a process
    is reported (measured below);
  - a run that set the switches never showed its first window, found by a start marker at the next start (`no-window`).

  Turning the setting on again forgets the record. `orivon://gpu` says so (`x11-vulkan-reverted`), or that the setting
  is on and the page still got no adapter (`x11-vulkan-no-adapter`), and the bug report carries the setting's value at
  the start and the record.
- **Acceptance.** Orivon itself, with the setting on in its profile, on a page of known colours; the pixels are read
  from the X server's screen, not from Chromium. NVIDIA is Vulkan's default device here; Intel is reached with
  `VK_ICD_FILENAMES` limited to Intel's driver. Each cell is one run; the control rows have the setting off.

  | Check | xvfb, NVIDIA | xvfb, Intel | Xwayland, NVIDIA | Xwayland, Intel |
  |---|---|---|---|---|
  | `requestAdapter()` | `nvidia`, `ampere` | `intel`, `gen-12lp` | `nvidia`, `ampere` | `intel`, `gen-12lp` |
  | Compute dispatch read back | 2, 4, 6, 8 | 2, 4, 6, 8 | 2, 4, 6, 8 | 2, 4, 6, 8 |
  | WebGPU canvas of one colour, read from the screen | 20000 of 20000 pixels | 20000 of 20000 | 20000 of 20000 | 20000 of 20000 |
  | WebGL canvas of one colour, read from the screen | 40000 of 40000 | 40000 of 40000 | 40000 of 40000 | 40000 of 40000 |
  | WebGL renderer | ANGLE, Vulkan, RTX 3050 | ANGLE, Vulkan, Intel Iris Xe | the same as xvfb | the same as xvfb |
  | Painted block, read from the screen | 40000 of 40000 | 40000 of 40000 | 40000 of 40000 | 40000 of 40000 |
  | Scrolling by a wheel event | the block moved 300 px | 300 px | 300 px | 300 px |
  | VP9 and H.264 video | `currentTime` advances, the picture is on screen | the same | the same | the same |
  | `child-process-gone` | none | none | none | none |
  | Guard record after the run | no revert | no revert | no revert | no revert |
  | Control, setting off | no adapter, no WebGL (software drawing), video plays | | no adapter, WebGL through Intel's GL, video plays | |

  With no usable Vulkan driver (`VK_ICD_FILENAMES` naming a file that does not exist) and the setting on, the graphics
  process exits while it starts, again and again, pages are drawn on the processor, WebGL and WebGPU are off and the
  page gets no adapter, with no `child-process-gone`; ten seconds after the first window the guard turns the setting off
  and records `gpu-software`. A run with the graphics process killed by a signal records `gpu-crash`, and a profile
  whose last run never showed its window records `no-window` (both in `test/page/e2e-webgpu-x11.test.ts`).
- **Not measured.** A real Xorg session, which is the case upstream's block was written for (video composited blank on
  an NVIDIA hybrid laptop): whether the decoder picks the integrated GPU there is *provisional*. A person on Xorg with
  such a laptop who turns the setting on and reports through `orivon://report` would settle it. Hardware decoding of
  the two videos was not told apart from software decoding, and screen capture was not run.
- **The setting is retired** once Chromium turns the bridge back on under X11. Each Electron update checks for it.

## Step 4: Wayland, one GPU maker at a time (`d-0757`)

- **Mechanism:** `--ignore-gpu-blocklist=186`, which ignores that entry and nothing else, set only when the GPU
  Chromium uses is on Orivon's tested list.
- **Before `ready`:** main can read only each render node's vendor id and kernel driver from `/sys/class/drm` (plain
  `fs`, no native module).
- **The driver version** comes from the previous run's `app.getGPUInfo('complete')`, kept in the profile. So a newly
  covered computer gets WebGPU from its second start.
- **Hybrid laptops:** the switch applies only when the GPU Chromium used last run is tested. "The GPU Chromium used"
  is not `app.getGPUInfo()`'s `active` flag: on this machine it marks the NVIDIA GPU while WebGL, compositing and
  video run on the Intel one (the ANGLE renderer string says so) and, with the switch, the adapter is the NVIDIA one.
  The list therefore keys on the adapter's own vendor and architecture, and its test includes a WebGPU canvas page
  (step 1 measured compute only), because the adapter may sit on a different GPU than the compositor.
- **The crash guard** of step 3 applies.
- **One PR per GPU maker added:** one row in the tested list, plus the evidence of the test (which GPU, which driver,
  what ran, and who ran it).
- **Candidates**, by how many users they likely cover:
  1. Intel generations 9 to 11 (2015 to 2020 laptops);
  2. AMD (RADV);
  3. older NVIDIA drivers;
  4. the open NVIDIA drivers.
- **Testers:** this machine has none of these GPUs. A tester is either a user who reports through `orivon://report`, or
  a rented cloud machine with an AMD GPU. Renting one is the owner's call on cost.
- **The step starts** with the first GPU maker someone has tested; the mechanism is not built ahead of it.
- **Mesa's software Vulkan** (`lvp_icd.json`) cannot exercise the switch in tests: with
  `--ignore-gpu-blocklist=186` and only that driver visible, the graphics process crashed three times (exit 139) and
  Chromium fell back to software. The switch is exercised on a real GPU instead: this machine gets an adapter with it
  and none without it. A GPU process that crashes with the switch on is what the crash guard above is for.
- **`--render-node-override` to the NVIDIA node** is not a way to pick a GPU on a hybrid laptop under Wayland: the
  compositor renders on Intel, and the browser process died with a Wayland protocol error ("failed to import supplied
  dmabufs") in every run.

## Not planned

- **WebGPU on the CPU** stays blocked (`d-0759`).
- **`--enable-unsafe-webgpu`** is never set (see above).
- **WebGPU's compatibility mode** on Linux: Chromium 152 deliberately gives it no GL backend there.

## Watch at each Electron update

- **Re-read entry 186's exceptions**, and whether the bridge is still Wayland-only.
- **Adjust or retire:** step 1's spec fails if the CI platforms change. Step 3's setting and step 4's list are adjusted
  or retired to match.

## Privacy

- **What a page reads:** every computer that gains WebGPU also tells pages its GPU maker and family through
  `adapter.info`, as Chrome does on that computer.
- **Orivon adds nothing to it:** it does not pass `--enable-webgpu-developer-features`, so pages get no device,
  description or driver strings.
- **No fingerprinting protection** exists in this build (compatibility matrix, Fingerprinting protection row).
