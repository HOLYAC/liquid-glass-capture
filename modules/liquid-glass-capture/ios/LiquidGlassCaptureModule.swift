import ExpoModulesCore

public final class LiquidGlassCaptureModule: Module {
  public func definition() -> ModuleDefinition {
    Name("LiquidGlassCapture")

    Constant("purpose") {
      "Native Apple Liquid Glass capture harness"
    }

    View(LiquidGlassCaptureView.self) {
      ViewName("LiquidGlassCapture")

      Prop("mode") { (view: LiquidGlassCaptureView, value: String) in
        view.mode = CaptureMode(rawValue: value) ?? .glassOverSubstrate
      }

      Prop("substrate") { (view: LiquidGlassCaptureView, value: String) in
        view.substrate = SubstrateKind(rawValue: value) ?? .checker4
      }

      Prop("shape") { (view: LiquidGlassCaptureView, value: String) in
        view.probeShape = ProbeShape(rawValue: value) ?? .capsule
      }

      Prop("phase") { (view: LiquidGlassCaptureView, value: String) in
        view.phase = ProbePhase(rawValue: value) ?? .rest
      }

      Prop("tint") { (view: LiquidGlassCaptureView, value: String) in
        view.tint = GlassTint(rawValue: value) ?? .none
      }

      Prop("interactive") { (view: LiquidGlassCaptureView, value: Bool) in
        view.interactive = value
      }

      Prop("autoplay") { (view: LiquidGlassCaptureView, value: Bool) in
        view.autoplay = value
      }

      AsyncFunction("captureSnapshotAsync") { (view: LiquidGlassCaptureView, label: String, metadata: [String: Any]) -> [String: Any] in
        try view.captureSnapshot(label: label, metadata: metadata)
      }
      .runOnQueue(.main)

      AsyncFunction("captureLabArtifactAsync") { (view: LiquidGlassCaptureView, label: String, metadata: [String: Any]) -> [String: Any] in
        try view.captureLabArtifact(label: label, metadata: metadata)
      }
      .runOnQueue(.main)

      AsyncFunction("startCompositorCaptureAsync") { (view: LiquidGlassCaptureView, label: String, metadata: [String: Any], promise: Promise) in
        view.startCompositorCapture(label: label, metadata: metadata, promise: promise)
      }
      .runOnQueue(.main)

      AsyncFunction("stopCompositorCaptureAsync") { (view: LiquidGlassCaptureView, promise: Promise) in
        view.stopCompositorCapture(promise: promise)
      }
      .runOnQueue(.main)
    }
  }
}
