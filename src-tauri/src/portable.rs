// ポータブル版の土台：
//  ・設定や記録は exe の横の「CWCatalog-data」に置く（フォルダごと消せばアンインストール完了）
//  ・ダイアログで選んだフォルダの許可も、そこに覚えておく
//  ・前のインストール版（0.2.0 まで）の記録が残っていれば、初回だけ引き継ぐ
//  ・窓の大きさ・位置を覚える。初回は画面の大きさに合わせる

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Runtime, WebviewWindow};
use tauri_plugin_fs::FsExt;

pub const DATA_DIR_NAME: &str = "CWCatalog-data";
pub const STORE_DIR_NAME: &str = "CWCatalog_保存";
const OLD_IDENTIFIER: &str = "io.github.cwcatalog.tool";
const SCOPE_FILE: &str = "allowed-folders.json";
const WINDOW_FILE: &str = "window.json";
const MIGRATED_MARK: &str = "migrated-from-installer.txt";

pub struct Portable {
    pub data_dir: PathBuf,
    /// exe の横に置けたか（置けないときは、ユーザーのフォルダの中に置く）
    pub beside_exe: bool,
    pub migrated: Mutex<Option<String>>,
    allowed: Mutex<Vec<String>>,
    window: Mutex<Option<WindowState>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableInfo {
    data_dir: String,
    beside_exe: bool,
    migrated: Option<String>,
    exe: String,
}

fn writable(dir: &Path) -> bool {
    let p = dir.join(".write-test");
    std::fs::write(&p, b"ok").is_ok() && std::fs::remove_file(&p).is_ok()
}

fn fallback_root() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

impl Portable {
    pub fn init() -> Self {
        let exe_dir = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(Path::to_path_buf))
            .unwrap_or_else(std::env::temp_dir);
        let beside = exe_dir.join(DATA_DIR_NAME);
        let (data_dir, beside_exe) = if std::fs::create_dir_all(&beside).is_ok() && writable(&beside) {
            (beside, true)
        } else {
            // Program Files の中など、書き込めない場所に置かれたとき
            let d = fallback_root().join("CWCatalog-portable");
            let _ = std::fs::create_dir_all(&d);
            (d, false)
        };
        let allowed: Vec<String> = std::fs::read(data_dir.join(SCOPE_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let window = std::fs::read(data_dir.join(WINDOW_FILE))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok());
        let p = Portable {
            data_dir,
            beside_exe,
            migrated: Mutex::new(None),
            allowed: Mutex::new(allowed),
            window: Mutex::new(window),
        };
        p.migrate_from_installer();
        p
    }

    pub fn webview_dir(&self) -> PathBuf {
        self.data_dir.clone()
    }

    pub fn downloads_dir(&self) -> PathBuf {
        self.data_dir.join("downloads")
    }

    /// 最初から用意しておく保存フォルダ（exe の横の「CWCatalog_保存」）。exe の横に置けないときは CWCatalog-data の中
    pub fn store_root(&self) -> PathBuf {
        if self.beside_exe {
            if let Some(exe_dir) = self.data_dir.parent() {
                return exe_dir.join(STORE_DIR_NAME);
            }
        }
        self.data_dir.join(STORE_DIR_NAME)
    }

    /// 前のインストール版の記録（画面側のデータベース）と、選んだフォルダの許可を引き継ぐ
    fn migrate_from_installer(&self) {
        if self.data_dir.join(MIGRATED_MARK).exists() {
            return;
        }
        let new_idb = self.data_dir.join("EBWebView").join("Default").join("IndexedDB");
        let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else { return };
        let old_idb = local.join(OLD_IDENTIFIER).join("EBWebView").join("Default").join("IndexedDB");
        if new_idb.exists() || !old_idb.exists() {
            return;
        }
        if copy_dir(&old_idb, &new_idb).is_err() {
            let _ = std::fs::remove_dir_all(&new_idb);
            return;
        }
        // 0.2.0 までは persisted-scope が %APPDATA% に許可を保存していた
        let mut n = 0;
        if let Some(roaming) = std::env::var_os("APPDATA").map(PathBuf::from) {
            if let Ok(b) = std::fs::read(roaming.join(OLD_IDENTIFIER).join(".persisted-scope")) {
                let mut list = self.allowed.lock().unwrap();
                for pat in parse_old_scope(&b) {
                    if let Some(dir) = pat.strip_suffix("**").map(|s| s.trim_end_matches(['\\', '/'])) {
                        let dir = unescape_glob(dir);
                        if Path::new(&dir).is_dir() && !list.contains(&dir) {
                            list.push(dir);
                            n += 1;
                        }
                    }
                }
                let _ = std::fs::write(self.data_dir.join(SCOPE_FILE), serde_json::to_vec_pretty(&*list).unwrap_or_default());
            }
        }
        let _ = std::fs::write(
            self.data_dir.join(MIGRATED_MARK),
            format!("インストール版の記録を引き継ぎました：{}\n", old_idb.display()),
        );
        *self.migrated.lock().unwrap() = Some(format!(
            "前のインストール版の記録を引き継ぎました{}",
            if n > 0 { format!("（フォルダの許可 {n}件も）") } else { String::new() }
        ));
    }

    /// 覚えておいたフォルダの許可を戻し、これから選ばれるフォルダも覚えるようにする
    pub fn setup_scope<R: Runtime>(&'static self, app: &AppHandle<R>) {
        let scope = app.fs_scope();
        let _ = std::fs::create_dir_all(self.downloads_dir());
        let _ = scope.allow_directory(self.downloads_dir(), true);
        for d in self.allowed.lock().unwrap().iter() {
            if Path::new(d).is_dir() {
                let _ = scope.allow_directory(d, true);
            }
        }
        scope.listen(move |e| {
            if let tauri::fs::Event::PathAllowed(p) = e {
                if !p.is_dir() || p.starts_with(&self.data_dir) {
                    return;
                }
                let s = p.to_string_lossy().to_string();
                let mut list = self.allowed.lock().unwrap();
                if !list.contains(&s) {
                    list.push(s);
                    let _ = std::fs::write(self.data_dir.join(SCOPE_FILE), serde_json::to_vec_pretty(&*list).unwrap_or_default());
                }
            }
        });
    }

    pub fn info(&self) -> PortableInfo {
        PortableInfo {
            data_dir: self.data_dir.to_string_lossy().to_string(),
            beside_exe: self.beside_exe,
            migrated: self.migrated.lock().unwrap().take(),
            exe: std::env::current_exe().map(|p| p.to_string_lossy().to_string()).unwrap_or_default(),
        }
    }

    // ------------------------------------------------------------ 窓の大きさ
    /// 前回の大きさ・位置に戻す。無ければ画面の大きさに合わせて真ん中に出す
    pub fn place_window<R: Runtime>(&self, w: &WebviewWindow<R>) {
        let saved = self.window.lock().unwrap().clone();
        let monitors = w.available_monitors().unwrap_or_default();
        if let Some(s) = saved {
            let visible = monitors.iter().any(|m| {
                let a = m.work_area();
                let (ax, ay, aw, ah) = (a.position.x, a.position.y, a.size.width as i32, a.size.height as i32);
                s.x + 80 > ax && s.x < ax + aw - 80 && s.y >= ay - 10 && s.y < ay + ah - 60
            });
            if visible && s.w >= 380 && s.h >= 400 {
                let _ = w.set_size(PhysicalSize::new(s.w, s.h));
                let _ = w.set_position(PhysicalPosition::new(s.x, s.y));
                if s.max {
                    let _ = w.maximize();
                }
                return;
            }
        }
        if let Ok(Some(m)) = w.current_monitor().map(|m| m.or_else(|| monitors.first().cloned())) {
            let a = m.work_area();
            let sf = m.scale_factor();
            let lw = (a.size.width as f64 / sf * 0.92).min(1100.0).max(380.0);
            let lh = (a.size.height as f64 / sf * 0.90).min(820.0).max(480.0);
            let _ = w.set_size(tauri::LogicalSize::new(lw, lh));
        }
        let _ = w.center();
    }

    pub fn track_window<R: Runtime>(&'static self, w: &WebviewWindow<R>) {
        let win = w.clone();
        w.on_window_event(move |e| match e {
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                let max = win.is_maximized().unwrap_or(false);
                if win.is_minimized().unwrap_or(false) || win.is_fullscreen().unwrap_or(false) {
                    return;
                }
                let mut st = self.window.lock().unwrap();
                if max {
                    // 最大化中は、元に戻したときの大きさを残しておく
                    if let Some(s) = st.as_mut() {
                        s.max = true;
                    }
                    return;
                }
                if let (Ok(pos), Ok(size)) = (win.outer_position(), win.inner_size()) {
                    *st = Some(WindowState { x: pos.x, y: pos.y, w: size.width, h: size.height, max: false });
                }
            }
            tauri::WindowEvent::CloseRequested { .. } => {
                if let Some(s) = self.window.lock().unwrap().as_mut() {
                    s.max = win.is_maximized().unwrap_or(false);
                    let _ = std::fs::write(self.data_dir.join(WINDOW_FILE), serde_json::to_vec(s).unwrap_or_default());
                }
            }
            tauri::WindowEvent::Destroyed => {
                // メインの窓を閉じたら、配布ページの窓も含めてアプリを完全に終わらせる
                win.app_handle().exit(0);
            }
            _ => {}
        });
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WindowState {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    max: bool,
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let t = to.join(e.file_name());
        if e.file_type()?.is_dir() {
            copy_dir(&e.path(), &t)?;
        } else {
            std::fs::copy(e.path(), t)?;
        }
    }
    Ok(())
}

/// persisted-scope（bincode 1）の中身：Vec<String> 2つ（許可・禁止）。許可の方だけ読む
fn parse_old_scope(b: &[u8]) -> Vec<String> {
    let mut out = vec![];
    let rd = |i: usize| -> Option<u64> { b.get(i..i + 8).map(|s| u64::from_le_bytes(s.try_into().unwrap())) };
    let Some(n) = rd(0) else { return out };
    let mut i = 8;
    for _ in 0..n.min(10_000) {
        let Some(len) = rd(i) else { break };
        let len = len as usize;
        i += 8;
        let Some(s) = b.get(i..i + len) else { break };
        out.push(String::from_utf8_lossy(s).to_string());
        i += len;
    }
    out
}

/// glob の「[*]」のような書き方を元の文字に戻す
fn unescape_glob(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == '[' && i + 2 < c.len() && c[i + 2] == ']' {
            out.push(c[i + 1]);
            i += 3;
        } else {
            out.push(c[i]);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_scope() {
        let mut b = vec![];
        b.extend(2u64.to_le_bytes());
        for s in ["D:\\CW\\[[]x[]]\\**", "D:\\CW\\a.zip"] {
            b.extend((s.len() as u64).to_le_bytes());
            b.extend(s.as_bytes());
        }
        let v = parse_old_scope(&b);
        assert_eq!(v.len(), 2);
        assert_eq!(unescape_glob(v[0].strip_suffix("**").unwrap()), "D:\\CW\\[x]\\");
    }
}
