"use client";

import { useEffect } from "react";

/** Registers the service worker (installable app, offline fallback). */
export function PwaRegister() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {
      /* not a secure context, or blocked — the app still works as a normal site */
    });
  }, []);
  return null;
}
