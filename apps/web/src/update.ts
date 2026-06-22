// Desktop auto-update wrapper around the Tauri updater plugin.
//
// Everything here is a safe no-op on the web build: the @tauri-apps/* plugins are
// imported dynamically and only when running inside a Tauri (desktop) shell, so the
// browser bundle never pulls them in and never errors. iOS/Android update via their
// app stores, so this path is desktop-only.

export type UpdateStatus =
  | { state: "unsupported" }                       // web or mobile — no in-app updates
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string; notes?: string; date?: string }
  | { state: "uptodate" }
  | { state: "downloading"; pct?: number }
  | { state: "installing" }
  | { state: "ready" }                             // installed; relaunch to apply
  | { state: "error"; message: string };

/** True only inside a Tauri desktop shell. */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * Check for an update and, if requested, download + install it. Reports progress
 * through `onStatus`. Returns true if an update was installed (caller may relaunch).
 */
export async function runUpdate(
  onStatus: (s: UpdateStatus) => void,
  opts: { autoInstall?: boolean } = {},
): Promise<boolean> {
  if (!isDesktopApp()) { onStatus({ state: "unsupported" }); return false; }
  try {
    onStatus({ state: "checking" });
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) { onStatus({ state: "uptodate" }); return false; }

    onStatus({ state: "available", version: update.version, notes: update.body, date: update.date });
    if (!opts.autoInstall) return false;

    let total = 0;
    let downloaded = 0;
    await update.downloadAndInstall((event: any) => {
      switch (event.event) {
        case "Started":
          total = event.data?.contentLength ?? 0;
          onStatus({ state: "downloading", pct: 0 });
          break;
        case "Progress":
          downloaded += event.data?.chunkLength ?? 0;
          onStatus({ state: "downloading", pct: total ? Math.round((downloaded / total) * 100) : undefined });
          break;
        case "Finished":
          onStatus({ state: "installing" });
          break;
      }
    });
    onStatus({ state: "ready" });
    return true;
  } catch (e) {
    onStatus({ state: "error", message: (e as Error)?.message ?? String(e) });
    return false;
  }
}

/** Relaunch the app to apply an installed update (desktop only). */
export async function relaunchApp(): Promise<void> {
  if (!isDesktopApp()) return;
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch { /* ignore */ }
}

/**
 * Silent background check on launch. If an update is available it auto-downloads,
 * installs, and relaunches. Call once at startup; safe everywhere.
 */
export async function autoUpdateOnLaunch(): Promise<void> {
  if (!isDesktopApp()) return;
  const installed = await runUpdate(() => {}, { autoInstall: true });
  if (installed) await relaunchApp();
}
