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

```bash
npm run artifact:validate -- ./artifacts/sample.capture.json
npm run color:normalize -- ./artifacts/sample.capture.json --out ./artifacts/color.report.json
npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --out ./artifacts/ios-capture-plan.json
npm run ios:capture -- --rig R0 --scene S01_SEARCH --state rest --device physical --capture compositor --repeat 50 --manifest ./artifacts/r0.repeat-manifest.json
npm run null:ladder -- --native ./artifacts/r0.capture.json --candidate ./artifacts/c0.capture.json --rung flat_p3_grey --out ./artifacts/null.report.json
npm run metrics:compare -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g2.report.json
npm run metrics:optics -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g3-optics.report.json
npm run metrics:temporal -- --reference ./artifacts/r0.capture.json --candidate ./artifacts/r1.capture.json --out ./artifacts/g4-temporal.report.json
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
Baseline: repeat policy + instrument-noise/candidate-gap summaries
Viewer: artifact/baseline inspect, R-vs-C diff, debug heatmap, G2/G3/G4 summaries, null/energy/identifiability panels
```

Current G3 mask scope is `edge_band_inferred_from_residual_v0` until exported
pixel masks land in the capture artifact. Reports keep that method note in-band
so prototype optics numbers cannot be mistaken for final G3 verdicts.

Current G4 temporal scope is sequence-based and gateable only when both
artifacts carry the same `frame_pack.trajectory_source_sha256`. Missing or
divergent gesture source hashes make the temporal report fail by design,
because otherwise it measures runner drift instead of glass motion.

The app bottom bar exposes `B` for batch capture. It runs ReplayKit compositor
capture repeatedly, writes a `repeat_capture_manifest`, and enforces nominal
thermal state before each baseline iteration.

The baseline script marks reports as `partial` until enough physical captures
exist for the requested class (`mvl = 50`, `prod_p99 = 300`, `sustained = 24`).
That is intentional: a partial baseline is useful evidence, not a final verdict.

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
