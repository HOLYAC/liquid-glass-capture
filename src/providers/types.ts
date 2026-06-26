import type { ProviderId } from "../controller/types";

// A provider mints a token for a sitekey. hCaptcha is live (native); the rest are
// declared but gated behind a portability spike (see the farm plan). Keeping them
// in the registry lets the UI show the whole combine and light each up as it passes.
export type Portability = "proven" | "likely" | "per-site" | "weak" | "none";

export type ProviderInfo = {
  id: ProviderId;
  label: string;
  live: boolean;            // wired to a working native minter right now
  portability: Portability;
  note: string;
};
