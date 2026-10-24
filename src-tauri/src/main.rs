// CWカタログ（ポータブル版）
// 処理の中身はほとんど画面側（JavaScript）にあり、ここでは次のことだけをする：
//  ・ポータブル版の土台（記録は exe の横の CWCatalog-data に置く・窓の大きさを覚える）  portable.rs
//  ・「更新を確認」からの、署名を確かめた自分自身の入れ替え                          update.rs
//  ・「ダウンロード」フォルダから選ぶ・DL元のURLを読む                                downloads.rs
//  ・.wsn・右クリック・cwcatalog:// リンクの登録（設定で押した人だけ）                 winint.rs
//  ・アプリ内ブラウザで配布ページを開き、落ちてきたファイルを受け取る窓
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod portable;
mod update;
mod winint;

use std::sync::{Mutex, OnceLock};
use tauri::webview::DownloadEvent;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_fs::FsExt;

static PORTABLE: OnceLock<portable::Portable> = OnceLock::new();
fn portable() -> &'static portable::Portable {
    PORTABLE.get().expect("portable")
}

/// 起動したときに渡された、開くファイル・リンク（画面の準備ができたら取りに来る）
struct OpenArgs(Mutex<Vec<String>>);

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

/// 開くように渡されたファイルを、読めるようにする（シナリオらしい拡張子のファイルだけ）
fn allow_open_files<R: tauri::Runtime>(app: &tauri::AppHandle<R>, args: &[String]) {
    for a in args {
        let p = std::path::Path::new(a);
        if !a.to_ascii_lowercase().starts_with("cwcatalog:") && p.is_file() {
            let _ = app.fs_scope().allow_file(p);
        }
    }
}

/// 配布ページを別の窓で開く。本人がサイトのダウンロードボタンを押すと、
/// ファイルは CWCatalog-data\downloads に保存され、main 窓に「cw-download」で知らせる。
/// この窓は外部のページなので、アプリの機能（ファイル操作など）には一切触れない
/// （capabilities は main 窓にしか与えていない）。ログインの状態は CWCatalog-data に残る。
#[tauri::command]
async fn open_download_window(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let target: tauri::Url = url.parse().map_err(|_| "URLが正しくありません".to_string())?;
    if target.scheme() != "https" && target.scheme() != "http" {
        return Err("http・https のページだけ開けます".into());
    }
    if let Some(old) = app.get_webview_window("dl") {
        let _ = old.destroy();
    }
    let dir = portable().downloads_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let app_dl = app.clone();
    let window = WebviewWindowBuilder::new(&app, "dl", WebviewUrl::External(target))
        .title("配布ページ ― サイトのダウンロードボタンを押すと、CWカタログが受け取ります")
        .inner_size(1000.0, 760.0)
        .data_directory(portable().webview_dir())
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

#[tauri::command]
fn portable_info() -> portable::PortableInfo {
    portable().info()
}

#[tauri::command]
fn take_open_args(state: tauri::State<OpenArgs>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().unwrap())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // 更新の直後なら、古い版が終わるのを待ってから始める
    update::cleanup_old(args.iter().any(|a| a == "--updated"));
    let _ = PORTABLE.set(portable::Portable::init());
    let first_open = winint::open_args(&args);

    tauri::Builder::default()
        // 2つ目に起動されたら（.wsn をダブルクリック・リンクなど）、最初の窓に渡して終わる
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let open = winint::open_args(&argv);
            allow_open_files(app, &open);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if !open.is_empty() {
                let _ = app.emit_to("main", "cw-open-args", open);
            }
        }))
        // ファイル操作。触れるのはユーザーがダイアログで選んだフォルダと、CWCatalog-data\downloads だけ
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        // カタログ・作者さんの配布元へのアクセス（ブラウザの制限なし）
        .plugin(tauri_plugin_http::init())
        // 配布ページを普段のブラウザで開く・CardWirthの起動
        .plugin(tauri_plugin_opener::init())
        .manage(OpenArgs(Mutex::new(first_open.clone())))
        .setup(move |app| {
            let p = portable();
            p.setup_scope(app.handle());
            allow_open_files(app.handle(), &first_open);
            let w = WebviewWindowBuilder::new(app, "main", WebviewUrl::default())
                .title("CWカタログ")
                .inner_size(1100.0, 820.0)
                .min_inner_size(380.0, 480.0)
                .disable_drag_drop_handler()
                .data_directory(p.webview_dir())
                .visible(false)
                .build()?;
            p.place_window(&w);
            p.track_window(&w);
            w.show()?;
            let _ = w.set_focus();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_download_window,
            portable_info,
            take_open_args,
            update::portable_update_install,
            update::update_key_configured,
            downloads::downloads_list,
            downloads::downloads_read,
            downloads::zone_info,
            winint::assoc_status,
            winint::assoc_register,
            winint::assoc_unregister,
        ])
        .run(tauri::generate_context!())
        .expect("CWカタログを起動できませんでした");
}
