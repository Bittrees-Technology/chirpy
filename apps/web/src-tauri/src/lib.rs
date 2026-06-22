// Shared entrypoint for desktop (macOS) and mobile (iOS). The same Vite + React
// frontend is loaded into a native webview on every platform, so the entire chat
// UI is shared — only this thin shell differs per target.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // Desktop-only: auto-update (check signed release manifest → download → install →
    // relaunch) and process control (relaunch). Mobile updates go through the app stores.
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running Chirp");
}
