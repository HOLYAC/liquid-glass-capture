import type { ProviderInfo } from "./types";

// The combine roster. `live` = a token we can actually mint + a consumer that
// accepts it has been proven. Everything else carries WHY it's still dark so the
// UI never implies a farm we haven't measured (portability is empirical here).
export const PROVIDERS: ProviderInfo[] = [
  {
    id: "hcaptcha",
    label: "hCaptcha",
    live: true,
    portability: "proven",
    note: "Portable bearer token — 413 minted live against EL. The one working provider.",
  },
  {
    id: "friendly",
    label: "Friendly Captcha",
    live: false,
    portability: "likely",
    note: "Proof-of-work token; likely portable. Needs native SDK + a portability spike.",
  },
  {
    id: "geetest",
    label: "GeeTest v4",
    live: false,
    portability: "per-site",
    note: "Behavioural; portability varies per site — spike before trusting.",
  },
  {
    id: "tencent",
    label: "Tencent Captcha",
    live: false,
    portability: "per-site",
    note: "APAC ecosystem; spike required.",
  },
  {
    id: "netease",
    label: "NetEase YiDun",
    live: false,
    portability: "per-site",
    note: "APAC ecosystem; spike required.",
  },
  {
    id: "recaptcha_ent",
    label: "reCAPTCHA Enterprise",
    live: false,
    portability: "weak",
    note: "Action/score-bound, often single-use — likely NOT farmable. Spike to confirm.",
  },
];

export function liveProviders(): ProviderInfo[] {
  return PROVIDERS.filter((p) => p.live);
}

export function providerById(id: string): ProviderInfo | undefined {
  return PROVIDERS.find((p) => p.id === id);
}
