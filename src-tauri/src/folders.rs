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

/// Windows のごみ箱へ移す（自分のフォルダ一覧の「🗑️削除する」）。アプリが触れてよい場所（選んだフォルダ・保存フォルダ）の中だけ
#[tauri::command]
pub fn move_to_trash(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_absolute() || p.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err("場所の形が正しくありません".into());
    }
    if !p.exists() {
        return Err(format!("見つかりません：{path}"));
    }
    if !app.fs_scope().is_allowed(p) {
        return Err("この場所はごみ箱に移せません（設定で選んだフォルダの中だけ移せます）".into());
    }
    trash(p)
}

#[cfg(windows)]
fn trash(p: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOF_WANTNUKEWARNING, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // 名前の並びは「\0\0」で終わる決まり
    let mut from: Vec<u16> = p.as_os_str().encode_wide().collect();
    from.push(0);
    from.push(0);
    let mut op = SHFILEOPSTRUCTW {
        wFunc: FO_DELETE,
        pFrom: windows_core::PCWSTR(from.as_ptr()),
        // ALLOWUNDO＝ごみ箱へ。ごみ箱の無い場所（USBメモリ・ネットワークなど）で完全に消えてしまうときは、Windows が確かめる（WANTNUKEWARNING）
        fFlags: (FOF_ALLOWUNDO.0 | FOF_NOCONFIRMATION.0 | FOF_NOERRORUI.0 | FOF_SILENT.0 | FOF_WANTNUKEWARNING.0) as u16,
        ..Default::default()
    };
    let r = unsafe { SHFileOperationW(&mut op) };
    if op.fAnyOperationsAborted.0 != 0 {
        return Err("ごみ箱への移動を取りやめました".into());
    }
    if r != 0 || p.exists() {
        return Err(format!("ごみ箱に移せませんでした（{r}）"));
    }
    Ok(())
}

#[cfg(not(windows))]
fn trash(_p: &Path) -> Result<(), String> {
    Err("ごみ箱への移動は、Windows のアプリ版だけの機能です".into())
}
