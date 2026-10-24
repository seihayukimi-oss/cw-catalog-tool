//! 保存フォルダの用意と、エクスプローラーで開く。
use serde::Serialize;
use std::path::Path;
use tauri_plugin_fs::FsExt;

#[derive(Serialize)]
pub struct StoreDirs {
    root: String,
    zip: String,
    material: String,
    skin: String,
}

/// 最初から使える保存フォルダを作る（exe の横の CWCatalog_保存 の中に「zip保存」「素材」「スキン」）。
/// 作ったフォルダは、アプリが触れてよい場所として覚える。
#[tauri::command]
pub fn default_store_dirs(app: tauri::AppHandle) -> Result<StoreDirs, String> {
    let root = crate::portable().store_root();
    let sub = |name: &str| -> Result<String, String> {
        let p = root.join(name);
        std::fs::create_dir_all(&p).map_err(|e| format!("{}：{e}", p.display()))?;
        app.fs_scope().allow_directory(&p, true).map_err(|e| e.to_string())?;
        Ok(p.to_string_lossy().to_string())
    };
    Ok(StoreDirs { zip: sub("zip保存")?, material: sub("素材")?, skin: sub("スキン")?, root: root.to_string_lossy().to_string() })
}

/// フォルダをエクスプローラーで開く。アプリが触れてよいフォルダ（選んだフォルダ・保存フォルダ）だけ
#[tauri::command]
pub fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("フォルダが見つかりません：{path}"));
    }
    if !app.fs_scope().is_allowed(p) {
        return Err("このフォルダは開けません（設定で選んだフォルダだけ開けます）".into());
    }
    tauri_plugin_opener::open_path(p, None::<&str>).map_err(|e| e.to_string())
}
