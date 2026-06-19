export const colorPipelineContract = Object.freeze({
  embeddedIccProfile: "Display P3",
  workingSpace: "display-p3-linear",
  storedTransfer: "srgb-transfer",
  whitePoint: "D65"
});

export function validateArtifactColorContract(artifact) {
  const failures = [];
  const color = artifact?.color;
  if (!color || typeof color !== "object") {
    failures.push("COLOR_BLOCK_MISSING");
    return failures;
  }

  if (color.embedded_icc_profile !== colorPipelineContract.embeddedIccProfile) {
    failures.push("COLOR_ICC_PROFILE_NOT_DISPLAY_P3");
  }
  if (!isTrustedIccHash(color.icc_sha256)) {
    failures.push("COLOR_ICC_SHA256_MISSING_OR_UNTRUSTED");
  }
  if (color.working_space !== colorPipelineContract.workingSpace) {
    failures.push("COLOR_WORKING_SPACE_NOT_LINEAR_DISPLAY_P3");
  }
  if (color.stored_transfer !== colorPipelineContract.storedTransfer) {
    failures.push("COLOR_STORED_TRANSFER_NOT_SRGB_TRANSFER");
  }
  if (color.white_point !== colorPipelineContract.whitePoint) {
    failures.push("COLOR_WHITE_POINT_NOT_D65");
  }
  return failures;
}

export function srgbTransferToLinear(encodedByte) {
  const value = encodedByte / 255;
  if (value <= 0.04045) {
    return value / 12.92;
  }
  return Math.pow((value + 0.055) / 1.055, 2.4);
}

export function rgbaByteToLinearDisplayP3(pixels, offset) {
  return {
    r: srgbTransferToLinear(pixels[offset]),
    g: srgbTransferToLinear(pixels[offset + 1]),
    b: srgbTransferToLinear(pixels[offset + 2]),
    a: pixels[offset + 3] / 255
  };
}

export function linearDisplayP3ToXyzD65({ r, g, b }) {
  return {
    x: 0.4865709486482162 * r + 0.26566769316909306 * g + 0.1982172852343625 * b,
    y: 0.2289745640697488 * r + 0.6917385218365064 * g + 0.079286914093745 * b,
    z: 0.04511338185890264 * g + 1.043944368900976 * b
  };
}

export function linearDisplayP3ToOklab(linearP3) {
  const xyz = linearDisplayP3ToXyzD65(linearP3);
  const long = Math.cbrt(
    0.8190224432164319 * xyz.x +
      0.3619062562801221 * xyz.y -
      0.12887378261216414 * xyz.z
  );
  const medium = Math.cbrt(
    0.0329836671980271 * xyz.x +
      0.9292868468965546 * xyz.y +
      0.03614466816999844 * xyz.z
  );
  const short = Math.cbrt(
    0.048177199566046255 * xyz.x +
      0.26423952494422764 * xyz.y +
      0.6335478258136937 * xyz.z
  );

  return {
    l: 0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    a: 1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    b: 0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short
  };
}

export function oklabDelta(left, right) {
  const dl = left.l - right.l;
  const da = left.a - right.a;
  const db = left.b - right.b;
  return Math.sqrt(dl * dl + da * da + db * db);
}

export function displayP3LinearLuminance(linearP3) {
  return (
    0.2289745640697488 * linearP3.r +
    0.6917385218365064 * linearP3.g +
    0.079286914093745 * linearP3.b
  );
}

function isTrustedIccHash(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  return !/^(unverified|missing|missing-display-p3-icc|self-test-display-p3)$/i.test(value);
}
