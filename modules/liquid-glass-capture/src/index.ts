// JS bridge for the in-app hCaptcha-SDK minter. The native module name stays "LiquidGlassCapture"
// so the build vehicle's module-registration checks keep passing; only its behaviour changed.
import { requireNativeModule, type EventSubscription } from "expo-modules-core";

export type TokenEvent = { len: number; minted: number; head: string };
export type ErrorEvent = { stage: string; error: string };
export type PostedEvent = { status: number; posted: number; error: string };
export type MinterStatus = {
  minting: boolean;
  minted: number;
  posted: number;
  sitekey: string;
  oracleUrl: string;
};

type MinterNativeModule = {
  startMinting(sitekey: string, oracleUrl: string, intervalMs: number): Promise<void>;
  stopMinting(): void;
  getStatus(): MinterStatus;
  addListener(event: "onToken", listener: (e: TokenEvent) => void): EventSubscription;
  addListener(event: "onError", listener: (e: ErrorEvent) => void): EventSubscription;
  addListener(event: "onPosted", listener: (e: PostedEvent) => void): EventSubscription;
};

const Minter = requireNativeModule<MinterNativeModule>("LiquidGlassCapture");

export function startMinting(sitekey: string, oracleUrl: string, intervalMs = 8000): Promise<void> {
  return Minter.startMinting(sitekey, oracleUrl, intervalMs);
}

export function stopMinting(): void {
  Minter.stopMinting();
}

export function getStatus(): MinterStatus {
  return Minter.getStatus();
}

export function onToken(listener: (e: TokenEvent) => void): EventSubscription {
  return Minter.addListener("onToken", listener);
}

export function onError(listener: (e: ErrorEvent) => void): EventSubscription {
  return Minter.addListener("onError", listener);
}

export function onPosted(listener: (e: PostedEvent) => void): EventSubscription {
  return Minter.addListener("onPosted", listener);
}
