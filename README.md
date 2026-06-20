# Liquid Glass Capture Expo

No-Mac install path for the Apple Liquid Glass capture harness.

Canonical execution plan for the one-binary calibration lab lives in
[`apple_glass_parity_execution_plan_v1_2.md`](apple_glass_parity_execution_plan_v1_2.md).

This is an Expo app with a local Expo native module:

```text
App.tsx                                  React Native control shell
modules/liquid-glass-capture/ios         SwiftUI Apple Liquid Glass view
eas.json                                 Cloud iOS build profiles
app.json                                 iOS 26 deployment target
```

Expo Go is not enough for this project. The glass view uses custom native SwiftUI code and Apple's Liquid Glass APIs, so you need an EAS-built development client or `.ipa`.

## First Build

```bash
cd liquid_glass_capture_expo
npm install
npm install -g eas-cli
eas login
eas init
eas build --profile development --platform ios
```

Open the EAS build link on the iPhone and install the internal build.

Current project link:

```text
@eclngqee/liquid-glass-capture
https://expo.dev/accounts/eclngqee/projects/liquid-glass-capture
```

Current blocker after `eas init`:

```text
Non-interactive build cannot create iOS internal-distribution credentials.
```

Run this command in an interactive terminal and answer the Apple credential/device prompts:

```bash
npx eas build --profile development --platform ios
```

For a physical iPhone internal/dev build, EAS needs Apple credentials and a registered device/provisioning profile. This is expected; it is not a JS or Swift source failure.

## No Paid Apple Developer, No Mac

The App Store/TestFlight/EAS-device route is blocked without Apple Developer Program signing.

The practical workaround is:

```text
GitHub Actions macos-26 builds an unsigned iPhoneOS IPA
Windows signs/installs that IPA with a free Apple ID via Sideloadly or AltStore
```

Limits:

- not official distribution;
- usually expires after 7 days with a free Apple ID;
- limited number of sideloaded apps/devices;
- use a throwaway Apple ID if you do not trust third-party sideload tools;
- if Apple changes free sideloading rules, this path can break.

Steps:

1. Put this `liquid_glass_capture_expo` folder in a GitHub repo root.
2. Push it.
3. Open GitHub repo -> `Actions`.
4. Run workflow:

```text
Build unsigned iOS IPA
```

5. Download artifact:

```text
LiquidGlassCapture-unsigned-ipa
```

6. On Windows, install the `.ipa` to iPhone using Sideloadly or AltStore with a free Apple ID.

This path uses GitHub's `macos-26` runner because the native module needs iOS 26 SDK for `glassEffect`.

## Run The App

After the dev build is installed:

```bash
npx expo start --dev-client
```

Scan the QR code with the installed development client.

## Lab Commands

The local lab scripts implement the first machine-checkable part of the
v1.2 plan:

The on-device scene surface now exposes the full v1.2 matrix: `S00_NULL`,
`S01_SEARCH`, `S02_LOUPE`, `S03_PRESS`, `S04_MORPH`, `S05_FLOATING_BAR`,
`S06_TINY_GLASS`, `S07_BUSY_PHOTO`, `S08_P3_GRADIENT`, `S09_NEAR_WHITE`,
`S10_NEAR_BLACK`, `S11_VIDEO_FRAME`, and
`S12_SYSTEM_MATERIAL_ADJACENCY`. Use the app's `scene` chip to select the
matching fixed `scene/state/substrate/gesture` bundle before pressing `B`.

```bash
npm run scene:contract -- --self-test
npm run trajectory:build -- --self-test
npm run material:probe -- --self-test
npm run artifact:validate -- ./artifacts/sample.capture.json
npm run color:normalize -- ./artifacts/sample.capture.json --out ./artifacts/color.report.json
npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --device-role mvl_primary --out ./artifacts/ios-capture-plan.json
npm run ios:capture -- --rig C1 --scene S07_BUSY_PHOTO --state busy_photo_rest --device physical --capture compositor --repeat 50 --device-role mvl_primary --out ./artifacts/ios-capture-s07-plan.json
npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --device-role mvl_primary --manifest ./artifacts/r0.repeat-manifest.json
npm run null:ladder -- --native ./artifacts/r0.capture.json --candidate ./artifacts/c0.capture.json --rung flat_p3_grey --out ./artifacts/null.report.json
npm run metrics:compare -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g2.report.json
npm run metrics:optics -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g3-optics.report.json
npm run metrics:temporal -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g4-temporal.report.json
npm run metrics:runtime -- --artifact ./artifacts/c1.capture.json --out ./artifacts/g5-runtime.report.json
npm run energy:stress -- --artifact ./artifacts/c1-sustained.capture.json --sustained --out ./artifacts/g6-energy.report.json
npm run solver:rank -- --candidate ./artifacts/c0-candidate-a.json --candidate ./artifacts/c0-candidate-b.json --out ./artifacts/solver.pareto.report.json
npm run artifact:store -- --put ./artifacts/c1.capture.png --class raw_png_frame --store ./artifacts/store --out ./artifacts/store/write.report.json
npm run artifact:store -- --verify-index ./artifacts/store/index.json --out ./artifacts/store/verify.report.json
npm run artifact:store -- --plan-retention ./artifacts/store/index.json --out ./artifacts/store/retention-plan.json
npm run device:lane -- --lane mvl --git-commit <sha> --out ./artifacts/device-lane/mvl.plan.json
npm run device:lane -- --lane prod_p99 --git-commit <sha> --out ./artifacts/device-lane/prod-p99.plan.json
npm run device:lane -- --plan ./artifacts/device-lane/mvl.plan.json --manifest ./artifacts/r0.repeat-manifest.json --manifest ./artifacts/r1.repeat-manifest.json --manifest ./artifacts/c1.repeat-manifest.json --manifest ./artifacts/domc.repeat-manifest.json --gate ./artifacts/g2.report.json --gate ./artifacts/g3-optics.report.json --gate ./artifacts/g4-temporal.report.json --gate ./artifacts/g5-runtime.report.json --gate ./artifacts/g6-energy.report.json --out ./artifacts/device-lane/mvl.report.json
npm run review:packet -- --packet ./artifacts/g7-review.packet.json --out ./artifacts/g7-review.report.json
npm run report:verdict -- --candidate ./artifacts/c1.capture.json --gate ./artifacts/g2.report.json --gate ./artifacts/g3-optics.report.json --gate ./artifacts/g4-temporal.report.json --gate ./artifacts/g5-runtime.report.json --gate ./artifacts/g6-energy.report.json --solver ./artifacts/solver.pareto.report.json --store-index ./artifacts/store/index.json --device-lane ./artifacts/device-lane/mvl.report.json --review ./artifacts/g7-review.report.json --out ./artifacts/g8-verdict.report.json
npm run ci:glass -- --out ./artifacts/ci/glass-gate.report.json
npm run metrics:baseline -- --ref-manifest ./artifacts/r0.repeat-manifest.json --probe-manifest ./artifacts/r1.repeat-manifest.json --class mvl --repeat 50 --out ./baselines/current.json
npm run glass:inspect -- ./artifacts/r0.capture.json --out ./artifacts/viewer/r0.inspect.html
npm run glass:diff -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/viewer/r0-r1.diff.html
npm run lab:self-test
```

Current metric scope:

```text
G1: Display P3 artifact contract + linear Display P3 normalization
G2: OKLab delta, SSIM/MS-SSIM, FLIP-style linear-P3 adapter, gradient smoothness
G3: inferred edge lensing, blur falloff, chromatic fringe, highlight/shadow, alpha/tint split
G4: motion-energy phase, press overshoot/damping/settle time, frame pacing, trajectory-source lock
G5: full-frame p95/dropped-frame runtime gate from artifact perf fields
G6: short/sustained stress, thermal gate, sustained degradation, energy trace availability policy
Solver: background-sweep loss over S07-S11, Pareto front, knee selection, identifiability lattice, claim constraints
Artifact Store: content-addressed blob writer, immutable hash manifest, retention plan with tombstones
Physical Lane: pending plan plus verifier for collected physical compositor/framebuffer repeat manifests
G7: structured design/product sign-off packet; artifact-bound blockers only
G8: final verdict report with separate technical/disposition/design classes
Scene Contract: fixed background, geometry, and capture timeline packs for every scene/state
Baseline: repeat policy + instrument-noise/candidate-gap summaries
Viewer: artifact/baseline/verdict inspect, R-vs-C diff, debug heatmap, G2-G6 summaries, G7 packet seed, null/energy/identifiability panels
```

Current scene-contract scope locks a fixed background pack, a
formula-versioned geometry pack (`ProbeMetrics.v1`), and a capture timeline
pack for every scene/state. App metadata and native capture artifacts carry the
background and geometry pack hashes in `environment` and the capture timeline
hash in `frame_pack`; physical-device lane verification rejects captures whose
scene/state contract does not match.

Current G2/G3 mask scope is fixture-defined: `glass_core_mask_pack_v1`
contains scene/state mask regions and the metric stack rasterizes them before
scoring. Reports name the exact mask id (`core`, `edge_band`, etc.) so prototype
numbers cannot silently fall back to whole-frame or residual-selected regions.

Current G4 temporal scope is sequence-based and gateable only when both
artifacts carry the same `frame_pack.trajectory_source_sha256`. Gesture scenes
S02/S03/S04 have one source fixture each, with XCUITest and PointerEvent
consumers compiled from that source and checked by `npm run trajectory:build`.
Missing or divergent gesture source hashes make the temporal report fail by
design, because otherwise it measures runner drift instead of glass motion.

Current G5 runtime scope uses ReplayKit sample-buffer PTS as a full-frame
interval proxy when a physical compositor capture writes `artifact.perf`.
Precise CPU/GPU split still needs a profiler-backed adapter.

Current G6 energy scope records thermal state, sustained duration,
frame-interval degradation, and whether a power trace exists. `trace_unavailable`
is reported in-band and becomes a hard failure only when the command is run with
`--require-energy-trace`; Instruments Power Profiler and MetricKit adapters are
the next layer, not silently faked here.

Current solver scope ranks externally generated C0/C1 candidate records rather
than pretending the CMA-ES/TPE renderer loop is complete. It refuses single
background scoring by requiring the S07-S11 degeneracy-breaking sweep, emits a
Pareto front across visual loss, runtime, and energy, selects a knee point, and
marks each parameter as `MEASURED`, `BOUNDED_AMBIGUOUS`,
`PROBABLE_UNDER_PRIOR`, or `AMBIGUOUS`. Non-measured parameters may support a
fit-level result, but not a parameter-level "matched Apple" claim.

Current artifact-store scope writes content-addressed blobs and an
append-preserved `hash-manifest.jsonl`, verifies that every indexed blob still
matches its SHA-256, and emits a retention plan. It does not silently delete
blobs; expired artifacts become delete candidates with tombstones and
`hash_manifest_preserved=true`. Baselines and release-candidate artifacts are
indefinite retention classes.

Current physical-device lane scope creates a machine-readable capture plan and
verifies collected repeat manifests artifact-by-artifact. It rejects simulator
artifacts, rejects `layer_snapshot`, requires compositor/framebuffer capture,
requires nominal thermal start, requires Low Power Mode off, verifies PNG and
mask hashes, enforces declared gesture-scene trajectory source hashes, and
checks G2-G6 reports for MVL/prod/sustained lanes. Production `prod_p99` lanes
also require three `device_matrix_role` manifests: `weakest_supported`,
`target`, and `latest_pro`; each role must carry matching artifact metadata and
resolve to distinct physical hardware via `device_info.model_identifier`.
Sustained lanes additionally require a sustained manifest class, 60s capture
duration, logged 60s cooldown, artifact-level sustained duration, recorded
degradation/frame-interval metrics, and G6 sustained/thermal evidence. Hosted
GitHub CI still cannot mint this evidence; it names the required lane report as
pending instead.

Current G7 scope validates a review packet rather than free-form taste: every
block needs scene, state, mask, artifact pointer, reviewer category, written
reason, owner, and ticket. Naked objections like "looks off" or "не нравится"
fail the gate.

Current G8 scope emits the two-axis verdict report. It refuses simulator/replay
verdicts, refuses C1 without `baked_verdict`, keeps DOM_C in `WEBKIT_PASS`
instead of allowing a fake SwiftUI claim, and carries solver-selected candidate
plus identifiability claim constraints into the final report when a solver
report is provided. When an artifact-store index is provided, G8 also carries
the candidate retention entry instead of pretending retention was recorded.
When a physical-device lane report is provided, non-pass lane status blocks the
final verdict instead of being buried as a note. G8 now also requires a locked
baseline report: missing, non-complete, unapproved, unfrozen, or hash-tampered
baselines block the final verdict.

Current CI scope is the source guillotine in `.github/workflows/glass-gate.yml`
with policy in `ci/glass-gate.yml`. It runs typecheck, the full lab self-test,
and workspace diff hygiene, then uploads `ci_glass_gate_report` as
`glass-gate-report`. Hosted CI is not a physical-device verdict lane; when
glass-affecting files change, the report marks physical capture as
`pending_device_lane` and `pending_physical_device_lane_report` rather than
pretending a simulator or Linux runner can mint parity.

The app bottom bar exposes `B` for batch capture. It runs ReplayKit compositor
capture repeatedly, writes a `repeat_capture_manifest`, and enforces nominal
thermal state before each baseline iteration. The controls include a `device`
role chip so the same installed binary can tag MVL and production-matrix
captures without changing native code.
Native capture artifacts record the human device family as `model_name` and the
hardware identifier from `utsname.machine` as `model_identifier`; generic
`UIDevice.current.model` values such as `iPhone` are rejected by the artifact
validator.

The baseline script marks reports as `partial` until enough physical captures
exist for the requested class (`mvl = 50`, `prod_p99 = 300`, `sustained = 24`).
That is intentional: a partial baseline is useful evidence, not a final verdict.
Each metric summary carries a deterministic bootstrap `p99_ci95_upper`, the
versioned IQR + modified-z outlier policy, retained raw/outlier/rejected
comparison samples, and baseline infrastructure health. Statistical outliers
without machine-proven artifact reasons stay in the threshold as
`UNKNOWN_OUTLIER`; too many outlier candidates fail health instead of silently
cleaning the baseline.
The same baseline file emits per-metric `threshold_derivation`: high-good
metrics such as SSIM are converted to loss, `SHADER_SLACK` and `WEBKIT_SLACK`
are named with owner and derivation, and the shader threshold explicitly uses
only instrument noise plus shader slack. WebKit gap remains a report-only
`no_worse_than_webkit` floor.
Baseline namespace is derived from an explicit `baseline_identity` block:
scene/state/rig, device model and identifier, iOS version/build, SDK build,
capture daemon version, renderer lockfile SHA, observable WebKit build or
`not_observable`, and null/pipeline qualification status.
Complete baselines require `--owner` plus `--approval`; otherwise they are
marked `invalid` with `BASELINE_OWNER_APPROVAL_REQUIRED`. Partial baselines can
remain unapproved evidence. Every baseline report is frozen by a canonical
`baseline_freeze.content_sha256` and carries baseline retention metadata.
G8 verdicts require that locked baseline to be production-P99 eligible:
`repeat_policy.final_p99_allowed` must be true, so MVL/day-one baselines can
inform threshold work but cannot mint `PROD_PASS`.

## Production / TestFlight

```bash
eas build --profile production --platform ios
eas submit --platform ios
```

## Capture Logic

For every scenario, capture the same parameters in three modes:

```text
substrate_only
glass_over_substrate
glass_over_black
```

Those three images let us separate:

```text
glass body / absorption
substrate displacement
chromatic fringe
edge caustic
merge dynamics
```

## Current Control Surface

The app exposes:

```text
mode
substrate
shape
phase
tint
interactive
autoplay
```

Long-press the top-left 44px corner to restore controls after hiding them.

## Important

The native module requires iOS 26 SDK because it calls:

```swift
glassEffect(_:in:)
GlassEffectContainer(spacing:)
Glass.interactive()
```

If EAS fails with missing `Glass` / `glassEffect`, the build image is not using the needed Xcode/iOS SDK yet. In that case switch EAS image/Xcode version or build after Expo/EAS supports the new SDK image.
