// Shared entrypoint for desktop (macOS) and mobile (iOS). The same Vite + React
// frontend is loaded into a native webview on every platform, so the entire chat
// UI is shared — only this thin shell differs per target.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Parley");
}
