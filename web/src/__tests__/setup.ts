/**
 * Test setup for web unit tests.
 *
 * Mocks browser APIs (canvas, Image, URL.createObjectURL) and Zustand stores.
 */

import "@testing-library/jest-dom/vitest";

// ── Mock URL.createObjectURL / revokeObjectURL ──────────────────
if (typeof URL.createObjectURL === "undefined") {
  let counter = 0;
  URL.createObjectURL = () => `blob:mock/${counter++}`;
  URL.revokeObjectURL = () => {};
}

// ── Mock atob / btoa (jsdom provides these, but node doesn't) ──
if (typeof atob === "undefined") {
  globalThis.atob = (str: string) => Buffer.from(str, "base64").toString("binary");
}
if (typeof btoa === "undefined") {
  globalThis.btoa = (str: string) => Buffer.from(str, "binary").toString("base64");
}

// Radix Select uses the Pointer Events capture contract, which jsdom does not
// implement. Keep the test DOM behavior aligned with a browser for these APIs.
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => {};
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (typeof HTMLElement !== "undefined" && !HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

// Radix Slider measures its track with ResizeObserver, which jsdom does not provide.
if (typeof ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
