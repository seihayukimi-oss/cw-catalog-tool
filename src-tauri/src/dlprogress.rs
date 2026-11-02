//! アプリ内ブラウザのダウンロードの進み具合。
//! Windows では、ブラウザ部品（WebView2）のダウンロードの情報（受け取った量・全体の量）を読む。
//! 読めないときのために、置き場（CWCatalog-data\downloads）のファイルの大きさも見る。
//! どちらも「大きさを見るだけ」で、ファイルを開いたり実行したりはしない。
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static GOT: AtomicU64 = AtomicU64::new(0);
static TOTAL: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, serde::Serialize)]
struct Progress {
    got: u64,
    total: u64,
}

/// 置き場の中で、いちばん大きいファイルの大きさ（ダウンロード中のもの）
fn biggest_file(dir: &std::path::Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| {
            rd.flatten()
                .filter(|e| !e.file_name().to_string_lossy().starts_with("net-"))
                .filter_map(|e| e.metadata().ok())
                .filter(|m| m.is_file())
                .map(|m| m.len())
                .max()
                .unwrap_or(0)
        })
        .unwrap_or(0)
}

/// ダウンロードが始まった（画面に進み具合を知らせ始める）
pub fn started(app: &tauri::AppHandle) {
    GOT.store(0, Ordering::Relaxed);
    if ACTIVE.swap(true, Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    let dir = crate::portable().downloads_dir();
    std::thread::spawn(move || {
        let begin = Instant::now();
        while ACTIVE.load(Ordering::SeqCst) && begin.elapsed() < Duration::from_secs(3 * 60 * 60) {
            std::thread::sleep(Duration::from_millis(400));
            let got = GOT.load(Ordering::Relaxed).max(biggest_file(&dir));
            let total = TOTAL.load(Ordering::Relaxed);
            let _ = app.emit_to("main", "cw-dl-progress", Progress { got, total });
        }
    });
}

/// ダウンロードが終わった（知らせるのをやめる）
pub fn finished() {
    ACTIVE.store(false, Ordering::SeqCst);
    TOTAL.store(0, Ordering::Relaxed);
}

/// アプリ内ブラウザの窓に、ダウンロードの量を読む仕組みを付ける（Windows だけ）
#[cfg(windows)]
pub fn attach(w: &tauri::WebviewWindow) {
    let _ = w.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::{BytesReceivedChangedEventHandler, DownloadStartingEventHandler};
        use windows_core::Interface;
        let Ok(core) = pw.controller().CoreWebView2() else { return };
        let Ok(core4) = core.cast::<ICoreWebView2_4>() else { return };
        let mut token: i64 = 0;
        let _ = core4.add_DownloadStarting(
            &DownloadStartingEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let op = args.DownloadOperation()?;
                let mut total: i64 = 0;
                if op.TotalBytesToReceive(&mut total).is_ok() && total > 0 {
                    TOTAL.store(total as u64, Ordering::Relaxed);
                }
                let mut t2: i64 = 0;
                op.add_BytesReceivedChanged(
                    &BytesReceivedChangedEventHandler::create(Box::new(|op, _| {
                        if let Some(op) = op {
                            let (mut got, mut total) = (0i64, 0i64);
                            if op.BytesReceived(&mut got).is_ok() {
                                GOT.store(got.max(0) as u64, Ordering::Relaxed);
                            }
                            if op.TotalBytesToReceive(&mut total).is_ok() && total > 0 {
                                TOTAL.store(total as u64, Ordering::Relaxed);
                            }
                        }
                        Ok(())
                    })),
                    &mut t2,
                )?;
                Ok(())
            })),
            &mut token,
        );
    });
}

#[cfg(not(windows))]
pub fn attach(_w: &tauri::WebviewWindow) {}
