// CWカタログ（アプリ版）
// 処理の中身はほとんど画面側（JavaScript）にあり、ここではTauri公式のプラグインの登録と、
// 「アプリ内ブラウザで配布ページを開き、落ちてきたファイルを受け取る」窓だけを作る。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::webview::DownloadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Clone, serde::Serialize)]
struct DownloadDone {
    path: Option<String>,
    url: String,
    success: bool,
}

/// Windowsで使えない文字を置き換えたファイル名
fn safe_file_name(name: &str) -> String {
    let n: String = name
        .chars()
        .map(|c| if "\\/:*?\"<>|".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    let n = n.trim().trim_end_matches(['.', ' ']).to_string();
    if n.is_empty() { "download.bin".into() } else { n }
}

/// 配布ページを別の窓で開く。本人がサイトのダウンロードボタンを押すと、
/// ファイルはアプリ専用の一時フォルダに保存され、main 窓に「cw-download」で知らせる。
/// この窓は外部のページなので、アプリの機能（ファイル操作など）には一切触れない
/// （capabilities は main 窓にしか与えていない）。
#[tauri::command]
async fn open_download_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target: tauri::Url = url.parse().map_err(|_| "URLが正しくありません".to_string())?;
    if target.scheme() != "https" && target.scheme() != "http" {
        return Err("http・https のページだけ開けます".into());
    }
    if let Some(old) = app.get_webview_window("dl") {
        let _ = old.destroy();
    }
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("downloads");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let app_dl = app.clone();
    let window = WebviewWindowBuilder::new(&app, "dl", WebviewUrl::External(target))
        .title("配布ページ ― サイトのダウンロードボタンを押すと、CWカタログが受け取ります")
        .inner_size(1000.0, 760.0)
        .on_download(move |webview, event| {
            match event {
                DownloadEvent::Requested { destination, .. } => {
                    let name = destination
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    let path = dir.join(safe_file_name(&name));
                    let _ = std::fs::remove_file(&path);
                    *destination = path;
                }
                DownloadEvent::Finished { url, path, success } => {
                    let _ = app_dl.emit_to(
                        "main",
                        "cw-download",
                        DownloadDone {
                            path: path.map(|p| p.to_string_lossy().to_string()),
                            url: url.to_string(),
                            success,
                        },
                    );
                    let _ = webview.window().close();
                }
                _ => {}
            }
            true
        })
        .build()
        .map_err(|e| e.to_string())?;

    let app_close = app.clone();
    window.on_window_event(move |e| {
        if let tauri::WindowEvent::Destroyed = e {
            let _ = app_close.emit_to("main", "cw-download-closed", ());
        }
    });
    Ok(())
}

fn main() {
    tauri::Builder::default()
        // ファイル操作。触れるのはユーザーがダイアログで選んだフォルダと、アプリの一時フォルダだけ
        .plugin(tauri_plugin_fs::init())
        // 選んだフォルダの許可を、次に起動したときも覚えておく（fsの後に登録する）
        .plugin(tauri_plugin_persisted_scope::init())
        .plugin(tauri_plugin_dialog::init())
        // カタログ・作者さんの配布元へのアクセス（ブラウザの制限なし）
        .plugin(tauri_plugin_http::init())
        // 配布ページを普段のブラウザで開く・CardWirthの起動
        .plugin(tauri_plugin_opener::init())
        // アプリ自体の更新
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![open_download_window])
        .run(tauri::generate_context!())
        .expect("CWカタログを起動できませんでした");
}
