// CWカタログ（ポータブル版）
// 処理の中身はほとんど画面側（JavaScript）にあり、ここでは次のことだけをする：
//  ・ポータブル版の土台（記録は exe の横の CWCatalog-data に置く・窓の大きさを覚える）  portable.rs
//  ・「更新を確認」からの、署名を確かめた自分自身の入れ替え                          update.rs
//  ・「ダウンロード」フォルダから選ぶ・DL元のURLを読む                                downloads.rs
//  ・.wsn・右クリック・cwcatalog:// リンクの登録（設定で押した人だけ）                 winint.rs
//  ・アプリ内ブラウザで配布ページを開き、落ちてきたファイルを受け取る窓
//  ・配布元からのダウンロード（日本語のファイル名を見出しに入れてくるサイトにも対応）          net.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod downloads;
mod folders;
mod net;
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

/// アプリ内ブラウザの窓の題名。ログイン情報を入れるのが不安にならないよう、何をしないかを書いておく
const BROWSER_NOTE: &str = "CWカタログのアプリ内ブラウザ：ログイン状態はこのPCに残すだけで、入力した内容やログイン情報をアプリが読み取ることはありません";
const BROWSER_TITLE: &str = "配布ページ ― サイトのダウンロードボタンを押すと受け取ります　｜　ログイン状態はこのPCに残すだけで、入力した内容やログイン情報をCWカタログが読み取ることはありません";

/// Googleドライブの「ダウンロード」のアドレスか。アプリ内ブラウザの中では受け取りにくいので、
/// 開かずにアドレスだけ画面側に渡して、画面側から直接取る（共有リンクで公開されているファイル）。
fn is_drive_download(u: &tauri::Url) -> bool {
    let host = u.host_str().unwrap_or("").to_ascii_lowercase();
    let path = u.path();
    let export = u.query_pairs().any(|(k, v)| k == "export" && v == "download");
    (host == "drive.usercontent.google.com" && (path.starts_with("/download") || path.starts_with("/u/")))
        || ((host == "drive.google.com" || host == "docs.google.com") && path.starts_with("/uc") && export)
}

#[derive(Clone, serde::Serialize)]
struct DownloadUrl {
    url: String,
}

static POPUP_SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

/// アプリ内ブラウザの窓を作る。ログインなどで開かれる小窓（window.open）も、同じ作りの窓で開く
/// （小窓でダウンロードが始まっても受け取れるように、ログインの状態も共有されるように）。
fn build_browser_window(
    app: &tauri::AppHandle,
    label: &str,
    url: WebviewUrl,
    features: Option<tauri::webview::NewWindowFeatures>,
) -> tauri::Result<tauri::WebviewWindow> {
    let dir = portable().downloads_dir();
    let _ = std::fs::create_dir_all(&dir);
    let app_dl = app.clone();
    let app_new = app.clone();
    let app_nav = app.clone();
    // 画面からはみ出さないよう、今のPCの画面（メインの窓がある画面）の大きさに合わせる
    let (w, h) = app
        .get_webview_window("main")
        .and_then(|m| m.current_monitor().ok().flatten())
        .map(|mon| {
            let a = mon.work_area();
            let sf = mon.scale_factor();
            ((a.size.width as f64 / sf * 0.9).clamp(400.0, 1200.0), (a.size.height as f64 / sf * 0.86).clamp(360.0, 900.0))
        })
        .unwrap_or((1000.0, 680.0));
    let mut b = WebviewWindowBuilder::new(app, label, url)
        .title(BROWSER_TITLE)
        .inner_size(w, h)
        .center()
        .data_directory(portable().webview_dir())
        .on_new_window(move |url, features| {
            if url.scheme() != "https" && url.scheme() != "http" && url.as_str() != "about:blank" {
                return tauri::webview::NewWindowResponse::Deny;
            }
            let n = POPUP_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            match build_browser_window(&app_new, &format!("dl-pop-{n}"), WebviewUrl::External("about:blank".parse().unwrap()), Some(features)) {
                Ok(window) => tauri::webview::NewWindowResponse::Create { window },
                Err(_) => tauri::webview::NewWindowResponse::Deny,
            }
        })
        .on_navigation(move |url| {
            if !is_drive_download(url) {
                return true;
            }
            let _ = app_nav.emit_to("main", "cw-download-url", DownloadUrl { url: url.to_string() });
            let app_close = app_nav.clone();
            tauri::async_runtime::spawn(async move {
                for (l, w) in app_close.webview_windows() {
                    if l == "dl" || l.starts_with("dl-pop-") {
                        let _ = w.close();
                    }
                }
            });
            false
        })
        .on_document_title_changed(|w, title| {
            if !title.is_empty() {
                let _ = w.set_title(&format!("{title}　｜　{BROWSER_NOTE}"));
            }
        })
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
                    // 受け取ったら、アプリ内ブラウザの窓（小窓も）を閉じる
                    for (l, w) in webview.app_handle().webview_windows() {
                        if l == "dl" || l.starts_with("dl-pop-") {
                            let _ = w.close();
                        }
                    }
                }
                _ => {}
            }
            true
        });
    if let Some(f) = features {
        b = b.window_features(f);
    }
    b.build()
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
    for (l, w) in app.webview_windows() {
        if l == "dl" || l.starts_with("dl-pop-") {
            let _ = w.destroy();
        }
    }
    let window = build_browser_window(&app, "dl", WebviewUrl::External(target), None).map_err(|e| e.to_string())?;
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
            net::cleanup_parts();
            net::cleanup_parts();
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
            net::net_fetch,
            net::net_take,
            folders::default_store_dirs,
            folders::open_folder,
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

#[cfg(test)]
mod tests {
    #[test]
    fn drive_download_urls() {
        let yes = [
            "https://drive.usercontent.google.com/download?id=abcdefghijk&export=download",
            "https://drive.google.com/uc?id=abcdefghijk&export=download",
            "https://docs.google.com/uc?export=download&id=abcdefghijk",
        ];
        let no = ["https://drive.google.com/file/d/abcdefghijk/view", "https://booth.pm/ja/items/1", "https://drive.google.com/drive/folders/abcdefghijk"];
        for u in yes {
            assert!(super::is_drive_download(&u.parse().unwrap()), "{u}");
        }
        for u in no {
            assert!(!super::is_drive_download(&u.parse().unwrap()), "{u}");
        }
    }
}
