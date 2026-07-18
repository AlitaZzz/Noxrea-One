/**
 * Test setup for frontend unit tests.
 *
 * Mocks browser APIs (canvas, Image, URL.createObjectURL) and Zustand stores.
 */

// ── Mock URL.createObjectURL / revokeObjectURL ──────────────────
if (typeof URL.createObjectURL === "undefined") {
  let counter = 0;
  URL.createObjectURL = (blob: Blob) => `blob:mock/${counter++}`;
  URL.revokeObjectURL = (url: string) => {};
}

// ── Mock atob / btoa (jsdom provides these, but node doesn't) ──
if (typeof atob === "undefined") {
  globalThis.atob = (str: string) => Buffer.from(str, "base64").toString("binary");
}
if (typeof btoa === "undefined") {
  globalThis.btoa = (str: string) => Buffer.from(str, "binary").toString("base64");
}
