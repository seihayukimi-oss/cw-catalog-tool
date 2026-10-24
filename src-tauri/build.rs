fn main() {
    // アプリ独自の命令を、権限設定の対象にする。
    // capabilities/default.json で main 窓だけに許可している（アプリ内ブラウザの窓には許可しない）。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&[
                "open_download_window",
                "portable_info",
                "take_open_args",
                "portable_update_install",
                "update_key_configured",
                "downloads_list",
                "downloads_read",
                "zone_info",
                "assoc_status",
                "assoc_register",
                "assoc_unregister",
            ])),
    )
    .expect("tauri-build に失敗しました");
}
