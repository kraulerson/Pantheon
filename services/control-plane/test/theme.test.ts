// @vitest-environment jsdom
/**
 * LibreChat-matched theme (design 2026-08-27): one shared stylesheet carrying LibreChat v0.8.7's
 * own token values, and a boot script that follows LibreChat's `color-theme` choice (same-origin
 * localStorage) or the OS preference. Colour is decoration — CC1 states stay words + glyphs.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { HARNESS_THEME_CSS, THEME_BOOT_JS, THEME_ASSET_PATH, XTERM_THEME_JS } from "../src/http/theme.js";

describe("HARNESS_THEME_CSS — LibreChat's tokens, not our own palette", () => {
  it("defines LibreChat's light and dark surfaces, text and borders, and its font stacks", () => {
    expect(THEME_ASSET_PATH).toBe("/assets/harness.css");
    const css = HARNESS_THEME_CSS;
    // dark: surface-primary gray-900, secondary gray-800, tertiary gray-700; text gray-100; border gray-700
    expect(css).toMatch(/html\.dark\s*\{[^}]*--surface-primary:\s*#0d0d0d/);
    expect(css).toMatch(/html\.dark\s*\{[^}]*--surface-secondary:\s*#212121/);
    expect(css).toMatch(/html\.dark\s*\{[^}]*--text-primary:\s*#ececec/);
    expect(css).toMatch(/html\.dark\s*\{[^}]*--border-medium:\s*#424242/);
    // light: surface-primary white, secondary gray-50; text gray-800; border-medium gray-300
    expect(css).toMatch(/:root\s*\{[^}]*--surface-primary:\s*#fff/);
    expect(css).toMatch(/:root\s*\{[^}]*--surface-secondary:\s*#f7f7f8/);
    expect(css).toMatch(/:root\s*\{[^}]*--text-primary:\s*#212121/);
    expect(css).toMatch(/:root\s*\{[^}]*--border-medium:\s*#cdcdcd/);
    expect(css).toContain("system-ui, Inter");
    expect(css).toContain("Roboto Mono");
    // body paints its own ground from the tokens (never the browser default white in dark mode)
    expect(css).toMatch(/body\s*\{[^}]*background:\s*var\(--surface-primary\)/);
  });
});

describe("THEME_BOOT_JS — follows LibreChat's color-theme choice", () => {
  beforeEach(() => {
    document.documentElement.className = "";
    // jsdom's storage is not reliable across vitest environments — a plain in-memory Storage is enough here.
    const store = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, String(v)), removeItem: (k: string) => void store.delete(k), clear: () => store.clear() }
    });
    (window as unknown as { matchMedia: unknown }).matchMedia = (q: string) => ({ matches: q.includes("dark"), addEventListener() {} });
  });
  it("applies the dark class when LibreChat's color-theme is dark", () => {
    window.localStorage.setItem("color-theme", "dark");
    window.eval(THEME_BOOT_JS);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("stays light when color-theme is light, even if the OS prefers dark", () => {
    window.localStorage.setItem("color-theme", "light");
    window.eval(THEME_BOOT_JS);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
  it("uses the OS preference for system or when nothing is stored", () => {
    window.localStorage.setItem("color-theme", "system");
    window.eval(THEME_BOOT_JS);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    document.documentElement.className = "";
    window.localStorage.removeItem("color-theme");
    window.eval(THEME_BOOT_JS);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("follows a later change made on the chat page (storage event)", () => {
    window.localStorage.setItem("color-theme", "dark");
    window.eval(THEME_BOOT_JS);
    window.localStorage.setItem("color-theme", "light");
    window.dispatchEvent(new window.StorageEvent("storage", { key: "color-theme", newValue: "light" }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});


describe("audit B follow-ups", () => {
  it("accepts LibreChat's JSON-quoted storage form (\"dark\") as well as the raw value", () => {
    document.documentElement.className = "";
    (window as unknown as { matchMedia: unknown }).matchMedia = () => ({ matches: false, addEventListener() {} }); // OS says light
    window.localStorage.setItem("color-theme", "\"dark\"");
    window.eval(THEME_BOOT_JS);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
  it("keeps terminals dark in both themes — xterm's ANSI palette is unreadable on white", () => {
    expect(XTERM_THEME_JS).toContain("#0d0d0d");
    expect(XTERM_THEME_JS).not.toContain("#ffffff");
    expect(HARNESS_THEME_CSS).toMatch(/\.term-host, #terminal \{[^}]*background: #0d0d0d/);
  });
});
