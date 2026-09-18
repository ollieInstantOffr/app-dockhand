"use client";

import type { Theme } from "./types";

const KEY = "dockhand-theme";

export function storedTheme(): Theme {
  try {
    return (localStorage.getItem(KEY) as Theme) || "system";
  } catch {
    return "system";
  }
}

export function isDark(t: Theme): boolean {
  return t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
}

export function applyTheme(t: Theme) {
  try {
    localStorage.setItem(KEY, t);
  } catch {}
  document.documentElement.classList.toggle("dark", isDark(t));
  document.documentElement.setAttribute("data-theme", isDark(t) ? "dark" : "light"); // Graphite charts
  const meta = document.querySelector('meta[name="theme-color"]:not([media])') ?? null;
  meta?.setAttribute("content", isDark(t) ? "#0d1016" : "#eef0f5");
}
