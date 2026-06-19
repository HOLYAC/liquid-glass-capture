# Liquid Glass Capture Expo

No-Mac install path for the Apple Liquid Glass capture harness.

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
