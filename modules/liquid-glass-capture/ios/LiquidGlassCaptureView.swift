import ExpoModulesCore
import SwiftUI
import UIKit

public final class LiquidGlassCaptureView: ExpoView {
  private let model = NativeHarnessModel()
  private var host: UIHostingController<NativeCaptureRootView>?

  public var mode: CaptureMode {
    get { model.mode }
    set { model.mode = newValue }
  }

  public var substrate: SubstrateKind {
    get { model.substrate }
    set { model.substrate = newValue }
  }

  public var probeShape: ProbeShape {
    get { model.shape }
    set { model.shape = newValue }
  }

  public var phase: ProbePhase {
    get { model.phase }
    set { model.phase = newValue }
  }

  public var tint: GlassTint {
    get { model.tint }
    set { model.tint = newValue }
  }

  public var interactive: Bool {
    get { model.interactive }
    set { model.interactive = newValue }
  }

  public var autoplay: Bool {
    get { model.autoplay }
    set { model.autoplay = newValue }
  }

  public required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    clipsToBounds = true
    backgroundColor = .black

    let controller = UIHostingController(rootView: NativeCaptureRootView(model: model))
    controller.view.backgroundColor = .clear
    host = controller
    addSubview(controller.view)
  }

  public override func layoutSubviews() {
    super.layoutSubviews()
    host?.view.frame = bounds
  }

  public func captureSnapshot(label: String, metadata: [String: Any]) throws -> [String: Any] {
    if bounds.width < 1 || bounds.height < 1 {
      throw NSError(domain: "LiquidGlassCapture", code: 1, userInfo: [NSLocalizedDescriptionKey: "View has no drawable bounds"])
    }

    layoutIfNeeded()

    let format = UIGraphicsImageRendererFormat()
    format.scale = UIScreen.main.scale
    format.opaque = true

    let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
    let image = renderer.image { _ in
      drawHierarchy(in: bounds, afterScreenUpdates: true)
    }

    guard let pngData = image.pngData() else {
      throw NSError(domain: "LiquidGlassCapture", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode PNG"])
    }

    let fileManager = FileManager.default
    let captureDir = try fileManager
      .url(for: .documentDirectory, in: .userDomainMask, appropriateFor: nil, create: true)
      .appendingPathComponent("LiquidGlassCaptures", isDirectory: true)
    try fileManager.createDirectory(at: captureDir, withIntermediateDirectories: true)

    let stamp = Int(Date().timeIntervalSince1970 * 1000)
    let safeLabel = label
      .replacingOccurrences(of: "[^A-Za-z0-9_.-]", with: "_", options: .regularExpression)
      .prefix(48)
    let basename = "\(stamp)-\(safeLabel)"
    let pngURL = captureDir.appendingPathComponent("\(basename).png")
    let jsonURL = captureDir.appendingPathComponent("\(basename).json")

    try pngData.write(to: pngURL, options: .atomic)

    var payload: [String: Any] = [
      "label": label,
      "timestampMs": stamp,
      "pngPath": pngURL.path,
      "jsonPath": jsonURL.path,
      "view": [
        "width": Double(bounds.width),
        "height": Double(bounds.height),
        "scale": Double(format.scale)
      ],
      "props": [
        "mode": model.mode.rawValue,
        "substrate": model.substrate.rawValue,
        "shape": model.shape.rawValue,
        "phase": model.phase.rawValue,
        "tint": model.tint.rawValue,
        "interactive": model.interactive,
        "autoplay": model.autoplay
      ],
      "metadata": metadata,
      "metrics": Self.metrics(for: image)
    ]

    let jsonData = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
    try jsonData.write(to: jsonURL, options: .atomic)
    payload["jsonPath"] = jsonURL.path
    return payload
  }

  private static func metrics(for image: UIImage) -> [String: Any] {
    guard let cgImage = image.cgImage else {
      return ["sampled": false]
    }

    let width = 96
    let height = 96
    let bytesPerPixel = 4
    let bytesPerRow = width * bytesPerPixel
    var pixels = [UInt8](repeating: 0, count: width * height * bytesPerPixel)

    let colorSpace = CGColorSpaceCreateDeviceRGB()
    guard let context = CGContext(
      data: &pixels,
      width: width,
      height: height,
      bitsPerComponent: 8,
      bytesPerRow: bytesPerRow,
      space: colorSpace,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else {
      return ["sampled": false]
    }

    context.interpolationQuality = .high
    context.draw(cgImage, in: CGRect(x: 0, y: 0, width: width, height: height))

    var lumas = [Double](repeating: 0, count: width * height)
    var lumaSum = 0.0
    var satSum = 0.0
    var minLuma = 1.0
    var maxLuma = 0.0

    for index in 0..<(width * height) {
      let offset = index * bytesPerPixel
      let red = Double(pixels[offset]) / 255.0
      let green = Double(pixels[offset + 1]) / 255.0
      let blue = Double(pixels[offset + 2]) / 255.0
      let luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue
      let high = max(red, green, blue)
      let low = min(red, green, blue)
      let saturation = high == 0 ? 0 : (high - low) / high

      lumas[index] = luma
      lumaSum += luma
      satSum += saturation
      minLuma = min(minLuma, luma)
      maxLuma = max(maxLuma, luma)
    }

    let count = Double(width * height)
    let meanLuma = lumaSum / count
    let meanSaturation = satSum / count
    var variance = 0.0
    var edgeEnergy = 0.0

    for y in 0..<height {
      for x in 0..<width {
        let index = y * width + x
        let delta = lumas[index] - meanLuma
        variance += delta * delta
        if x + 1 < width {
          edgeEnergy += abs(lumas[index] - lumas[index + 1])
        }
        if y + 1 < height {
          edgeEnergy += abs(lumas[index] - lumas[index + width])
        }
      }
    }

    let edgeSamples = Double((width - 1) * height + (height - 1) * width)
    return [
      "sampled": true,
      "sampleWidth": width,
      "sampleHeight": height,
      "meanLuma": meanLuma,
      "minLuma": minLuma,
      "maxLuma": maxLuma,
      "rmsContrast": sqrt(variance / count),
      "meanSaturation": meanSaturation,
      "edgeEnergy": edgeEnergy / edgeSamples
    ]
  }
}

final class NativeHarnessModel: ObservableObject {
  @Published var mode: CaptureMode = .glassOverSubstrate
  @Published var substrate: SubstrateKind = .checker4
  @Published var shape: ProbeShape = .capsule
  @Published var phase: ProbePhase = .rest
  @Published var tint: GlassTint = .none
  @Published var interactive = false
  @Published var autoplay = false
}

public enum CaptureMode: String {
  case substrateOnly = "substrate_only"
  case glassOverSubstrate = "glass_over_substrate"
  case glassOverBlack = "glass_over_black"
}

public enum SubstrateKind: String {
  case checker1 = "checker_1px"
  case checker2 = "checker_2px"
  case checker4 = "checker_4px"
  case checker8 = "checker_8px"
  case grid
  case rgbStripes = "rgb_stripes"
  case lumaRamp = "luma_ramp"
  case textWeights = "text_weights"
  case caretSelection = "caret_selection"
  case noise
}

public enum ProbeShape: String {
  case circle
  case capsule
  case roundedRect = "rounded_rect"
  case twinCapsules = "twin_capsules"
}

public enum ProbePhase: String {
  case rest
  case press
  case dragLeft = "drag_left"
  case dragRight = "drag_right"
  case mergeNear = "merge_near"
  case mergeOverlap = "merge_overlap"
  case morphTall = "morph_tall"
}

public enum GlassTint: String {
  case none
  case cyan
  case amber
  case red
}

struct NativeCaptureRootView: View {
  @ObservedObject var model: NativeHarnessModel

  var body: some View {
    TimelineView(.animation) { timeline in
      GeometryReader { proxy in
        let time = timeline.date.timeIntervalSinceReferenceDate
        ZStack {
          if model.mode == .glassOverBlack {
            Color.black
          } else {
            NativeSubstrateView(kind: model.substrate)
          }

          if model.mode != .substrateOnly {
            NativeGlassLayer(model: model, time: time, size: proxy.size)
          }
        }
        .ignoresSafeArea()
      }
    }
    .background(Color.black)
  }
}

struct NativeSubstrateView: View {
  let kind: SubstrateKind

  var body: some View {
    ZStack {
      Color.black
      switch kind {
      case .checker1, .checker2, .checker4, .checker8:
        Checkerboard(cell: checkerCell)
      case .grid:
        GridSubstrate()
      case .rgbStripes:
        RGBStripes()
      case .lumaRamp:
        LumaRamp()
      case .textWeights:
        TextWeights()
      case .caretSelection:
        CaretSelection()
      case .noise:
        NoiseSubstrate()
      }
    }
  }

  private var checkerCell: CGFloat {
    switch kind {
    case .checker1: return 1
    case .checker2: return 2
    case .checker4: return 4
    case .checker8: return 8
    default: return 4
    }
  }
}

struct Checkerboard: View {
  let cell: CGFloat

  var body: some View {
    Canvas { context, size in
      let cols = Int(ceil(size.width / cell))
      let rows = Int(ceil(size.height / cell))
      for y in 0...rows {
        for x in 0...cols {
          let value: Double = (x + y).isMultiple(of: 2) ? 0.92 : 0.06
          context.fill(
            Path(CGRect(x: CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)),
            with: .color(Color(white: value))
          )
        }
      }
    }
  }
}

struct GridSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
      for step in [8.0, 32.0, 96.0] {
        let alpha = step == 8 ? 0.22 : (step == 32 ? 0.42 : 0.68)
        var path = Path()
        var x = 0.0
        while x <= size.width {
          path.move(to: CGPoint(x: x, y: 0))
          path.addLine(to: CGPoint(x: x, y: size.height))
          x += step
        }
        var y = 0.0
        while y <= size.height {
          path.move(to: CGPoint(x: 0, y: y))
          path.addLine(to: CGPoint(x: size.width, y: y))
          y += step
        }
        context.stroke(path, with: .color(.white.opacity(alpha)), lineWidth: step == 96 ? 2 : 1)
      }
    }
  }
}

struct RGBStripes: View {
  var body: some View {
    Canvas { context, size in
      let colors: [Color] = [.red, .green, .blue, .cyan, .yellow, Color(red: 1, green: 0, blue: 1), .white, .black]
      let width = max(1, size.width / CGFloat(colors.count * 7))
      var x: CGFloat = 0
      var index = 0
      while x < size.width {
        context.fill(
          Path(CGRect(x: x, y: 0, width: width, height: size.height)),
          with: .color(colors[index % colors.count])
        )
        x += width
        index += 1
      }
    }
  }
}

struct LumaRamp: View {
  var body: some View {
    Rectangle()
      .fill(
        LinearGradient(
          stops: [
            .init(color: .black, location: 0),
            .init(color: .white, location: 0.36),
            .init(color: Color(white: 0.18), location: 0.5),
            .init(color: Color(white: 0.85), location: 0.72),
            .init(color: .black, location: 1)
          ],
          startPoint: .leading,
          endPoint: .trailing
        )
      )
  }
}

struct TextWeights: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 18) {
      ForEach([12, 16, 22, 32, 44, 64], id: \.self) { size in
        HStack(spacing: 22) {
          Text("glass probe \(size)")
            .font(.system(size: CGFloat(size), weight: .regular))
          Text("GLASS PROBE \(size)")
            .font(.system(size: CGFloat(size), weight: .bold))
        }
      }
    }
    .foregroundStyle(.white)
    .padding(54)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .center)
  }
}

struct CaretSelection: View {
  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 54, style: .continuous)
        .fill(Color(white: 0.12))
        .frame(width: 1040, height: 122)
      HStack(spacing: 0) {
        Text("glass ")
          .foregroundStyle(.white)
        Text("bubble")
          .foregroundStyle(.white)
          .background(Color(red: 0.14, green: 0.43, blue: 0.88).opacity(0.86))
        Rectangle()
          .fill(Color(red: 0.25, green: 0.86, blue: 1.0))
          .frame(width: 4, height: 72)
          .padding(.leading, 3)
      }
      .font(.system(size: 54, weight: .regular))
      .frame(width: 960, alignment: .leading)
    }
  }
}

struct NoiseSubstrate: View {
  var body: some View {
    Canvas { context, size in
      context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(.black))
      let cols = 96
      let rows = 54
      let cellW = size.width / CGFloat(cols)
      let cellH = size.height / CGFloat(rows)
      for y in 0..<rows {
        for x in 0..<cols {
          let seed = Double((x * 73856093) ^ (y * 19349663) & 255) / 255.0
          let color = Color(
            red: 0.06 + seed * 0.74,
            green: 0.08 + abs(sin(seed * 7.1)) * 0.62,
            blue: 0.08 + abs(cos(seed * 4.7)) * 0.82
          )
          context.fill(
            Path(CGRect(x: CGFloat(x) * cellW, y: CGFloat(y) * cellH, width: cellW + 1, height: cellH + 1)),
            with: .color(color)
          )
        }
      }
    }
  }
}

struct NativeGlassLayer: View {
  @ObservedObject var model: NativeHarnessModel
  let time: TimeInterval
  let size: CGSize

  var body: some View {
    let metrics = ProbeMetrics(model: model, time: time, stage: size)
    ZStack {
      switch model.shape {
      case .circle:
        singleGlass(frame: metrics.circleFrame, shape: .circle, cornerRadius: metrics.circleFrame.width * 0.5)
      case .capsule:
        singleGlass(frame: metrics.capsuleFrame, shape: .capsule, cornerRadius: metrics.capsuleFrame.height * 0.5)
      case .roundedRect:
        singleGlass(frame: metrics.rectFrame, shape: .roundedRect, cornerRadius: metrics.cornerRadius)
      case .twinCapsules:
        twinGlass(metrics: metrics)
      }
    }
    .animation(.smooth(duration: 0.42), value: model.phase)
    .animation(.smooth(duration: 0.42), value: model.shape)
  }

  @ViewBuilder
  private func singleGlass(frame: CGRect, shape: ProbeShape, cornerRadius: CGFloat) -> some View {
    let payload = Color.white.opacity(0.001)
      .frame(width: frame.width, height: frame.height)

    if #available(iOS 26.0, *) {
      switch shape {
      case .circle:
        payload.glassEffect(glassStyle, in: Circle())
          .position(x: frame.midX, y: frame.midY)
      case .capsule:
        payload.glassEffect(glassStyle, in: Capsule())
          .position(x: frame.midX, y: frame.midY)
      default:
        payload.glassEffect(glassStyle, in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
          .position(x: frame.midX, y: frame.midY)
      }
    } else {
      payload
        .background(.white.opacity(0.10), in: RoundedRectangle(cornerRadius: cornerRadius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).stroke(.white.opacity(0.22), lineWidth: 1))
        .position(x: frame.midX, y: frame.midY)
    }
  }

  @ViewBuilder
  private func twinGlass(metrics: ProbeMetrics) -> some View {
    if #available(iOS 26.0, *) {
      GlassEffectContainer(spacing: metrics.containerSpacing) {
        HStack(spacing: metrics.twinSpacing) {
          Color.white.opacity(0.001)
            .frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
            .glassEffect(glassStyle, in: Capsule())
          Color.white.opacity(0.001)
            .frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
            .glassEffect(glassStyle, in: Capsule())
        }
      }
      .position(x: metrics.center.x, y: metrics.center.y)
    } else {
      HStack(spacing: metrics.twinSpacing) {
        Capsule().fill(.white.opacity(0.12)).frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
        Capsule().fill(.white.opacity(0.12)).frame(width: metrics.twinSize.width, height: metrics.twinSize.height)
      }
      .position(x: metrics.center.x, y: metrics.center.y)
    }
  }

  @available(iOS 26.0, *)
  private var glassStyle: Glass {
    var glass: Glass = .regular
    switch model.tint {
    case .none:
      break
    case .cyan:
      glass = glass.tint(.cyan.opacity(0.32))
    case .amber:
      glass = glass.tint(.orange.opacity(0.34))
    case .red:
      glass = glass.tint(.red.opacity(0.30))
    }
    return model.interactive ? glass.interactive() : glass
  }
}

struct ProbeMetrics {
  let center: CGPoint
  let circleFrame: CGRect
  let capsuleFrame: CGRect
  let rectFrame: CGRect
  let cornerRadius: CGFloat
  let twinSize: CGSize
  let twinSpacing: CGFloat
  let containerSpacing: CGFloat

  init(model: NativeHarnessModel, time: TimeInterval, stage: CGSize) {
    let animated = model.autoplay ? CGFloat((sin(time * 1.7) + 1) * 0.5) : 0
    let width = max(1, stage.width)
    let height = max(1, stage.height)
    var cx = width * 0.5
    var cy = height * 0.56
    var squashX: CGFloat = 1
    var squashY: CGFloat = 1
    var scale: CGFloat = 1

    switch model.phase {
    case .rest:
      break
    case .press:
      squashX = 1.12 + animated * 0.06
      squashY = 0.88 - animated * 0.04
    case .dragLeft:
      cx -= width * (0.16 + animated * 0.04)
    case .dragRight:
      cx += width * (0.16 + animated * 0.04)
    case .mergeNear:
      scale = 0.98
    case .mergeOverlap:
      scale = 1.04
      squashX = 1.08
    case .morphTall:
      squashX = 0.76
      squashY = 1.24
      cy -= height * 0.05
    }

    center = CGPoint(x: cx, y: cy)
    let capsuleW = min(width * 0.70, 820) * scale * squashX
    let capsuleH = min(max(height * 0.12, 74), 120) * scale * squashY
    capsuleFrame = CGRect(x: cx - capsuleW * 0.5, y: cy - capsuleH * 0.5, width: capsuleW, height: capsuleH)

    let circleD = min(width, height) * 0.26 * scale * max(squashX, squashY)
    circleFrame = CGRect(x: cx - circleD * 0.5, y: cy - circleD * 0.5, width: circleD, height: circleD)

    let rectW = min(width * 0.48, 560) * scale * squashX
    let rectH = min(max(height * 0.24, 140), 230) * scale * squashY
    rectFrame = CGRect(x: cx - rectW * 0.5, y: cy - rectH * 0.5, width: rectW, height: rectH)
    cornerRadius = rectH * 0.22

    twinSize = CGSize(width: min(width * 0.20, 220) * scale, height: min(max(height * 0.11, 64), 96) * scale)
    switch model.phase {
    case .mergeNear:
      twinSpacing = 26 + animated * 12
      containerSpacing = 40
    case .mergeOverlap:
      twinSpacing = -18 - animated * 18
      containerSpacing = 84
    default:
      twinSpacing = 72 + animated * 18
      containerSpacing = 18
    }
  }
}
