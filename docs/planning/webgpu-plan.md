# WebGPU on as many computers as possible: plan

**Need.** The owner asked for WebGPU on as many computers as possible. Two kinds of users rely on it:
- local-model apps, ported to `@mlc-ai/web-llm` or to the WebGPU backends of `onnxruntime-web` and `@tensorflow/tfjs`
  ([Table 5](compatibility/table-5-native-modules.md));
- websites that require WebGPU.

**Decisions.** `d-0757` (Wayland, one GPU maker at a time), `d-0758` (X11, an opt-in setting) and `d-0759` (no CPU
fallback).

## Where WebGPU stands in this build

Orivon sets no GPU switch, so it runs Chromium 152's defaults (Electron 44.7). This was read from Chromium's source at
tag `152.0.7977.130`, not measured; step 1 measures it.

| Where | WebGPU |
|---|---|
| macOS 13 and later (Chromium 152's minimum) | On, through Metal |
| Windows | On, through D3D12, for AMD, Intel, NVIDIA and Microsoft's software renderer (WARP), and for Qualcomm with recent drivers. Other GPU makers are refused by Dawn's adapter blocklist |
| Linux, Wayland | On for Intel Gen12 and later on Mesa 22 or later, and for NVIDIA's driver 535.183.01 or later. Off for every other GPU |
| Linux, X11 | Off for every GPU |
| No usable GPU (a virtual machine, Qubes, an old computer) | Off: Dawn's adapter blocklist refuses CPU adapters |

Why Linux is narrow:
- The WebGPU service is on by default in the code (`kWebGPUService`, `gpu/config/gpu_finch_features.cc`), not through a
  field trial. Electron, which has no field trials, gets it.
- The adapter needs Vulkan, and Linux composites with GL. The bridge between them is the GPU feature
  `webgpu_on_vk_via_gl_interop`. Without it the backend is `Null` (`webgpu_decoder_impl.cc`).
- The bridge is set only by Ozone Wayland (`ozone_platform_wayland.cc`). Upstream turned it off on X11 as a temporary
  fix: on X11, creating a Vulkan device made the video decoder pick the integrated GPU, so video on an NVIDIA GPU
  composited blank (crbug 500609035).
- Blocklist entry 186 (`gpu/config/software_rendering_list.json`) refuses the bridge everywhere except two exceptions:
  - Intel: GPU generation 12 or later, driver vendor Mesa, Mesa 22.0 or later;
  - NVIDIA: driver 535.183.01 or later.
- `--enable-unsafe-webgpu` does not lift entry 186. It turns off timestamp quantization and Dawn's adapter blocklist,
  and exposes experimental features. Chrome warns that it lets a page read GPU data of other Chromium processes. Orivon
  never sets it.

## Step 1: measure, and pin what each platform gets

- **Probe** in a page:
  - `navigator.gpu`;
  - `requestAdapter()` and the adapter's `info`;
  - one compute dispatch read back;
  - `app.getGPUFeatureStatus()`.
- **Where the probe runs:**
  - this machine, with its Intel Gen12 and NVIDIA GPUs, under both a private headless Wayland session and X11, for the
    default and for each switch set step 3 considers;
  - GitHub's Windows and macOS runners, through `scripts/ci/cross-os.mjs`. Windows should get WARP, and macOS a
    virtual Metal device if the runner has one.
- **An e2e spec** pins the result per platform on CI, so a Chromium update that changes it fails a check, not a user.
- **The compatibility-matrix row** "WebGL / WebGPU" gets the measured values in place of the ones read from source.

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

- **The setting:** off by default, offered only on an X11 session, and it takes effect at the next start. Its words are
  shown to the owner before it merges (new visible UI).
- **What it does:** composite through Vulkan, so WebGPU needs no bridge. The candidate set is
  `--use-angle=vulkan --enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan`; step 1 settles the exact set.
- **Crash guard:** if the graphics process crashes while the setting is on, Orivon turns it off at the next start and
  says so in `orivon://gpu`.
- **Acceptance** on this machine's X11 session, on both GPUs:
  - video, hardware-decoded on the NVIDIA GPU (the upstream reason for the block);
  - a WebGL page;
  - scrolling;
  - screen capture;
  - a WebGPU compute page.
- **An ADR** (Rule 1): a setting that changes the compositor for every page.
- **The setting is retired** once Chromium turns the bridge back on under X11. Each Electron update checks for it.

## Step 4: Wayland, one GPU maker at a time (`d-0757`)

- **Mechanism:** `--ignore-gpu-blocklist=186`, which ignores that entry and nothing else, set only when the GPU
  Chromium uses is on Orivon's tested list.
- **Before `ready`:** main can read only each render node's vendor id and kernel driver from `/sys/class/drm` (plain
  `fs`, no native module).
- **The driver version** comes from the previous run's `app.getGPUInfo('complete')`, kept in the profile. So a newly
  covered computer gets WebGPU from its second start.
- **Hybrid laptops:** the switch applies only when the GPU Chromium used last run is tested.
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
- **Mesa's software Vulkan** (`lvp_icd.json`) exercises the switch in tests but never joins the tested list: it is a
  CPU adapter.

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
