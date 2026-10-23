fn main() {
    // アプリ独自の命令（アプリ内ブラウザを開く）を、権限設定の対象にする。
    // capabilities/default.json で main 窓だけに許可している。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["open_download_window"])),
    )
    .expect("tauri-build に失敗しました");
}
