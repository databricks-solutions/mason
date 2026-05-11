// Ambient typing so renderer JS/TS modules see `window.api` as the
// strongly-typed MasonApi contract instead of `any`.
import type { MasonApi } from "../shared/api";

declare global {
  interface Window {
    api: MasonApi;
  }
}

export {};
