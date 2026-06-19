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
    }
  }
}
