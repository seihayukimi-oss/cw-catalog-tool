// 「ダウンロード」フォルダから選ぶ：ブラウザで落とした zip・wsn などを一覧にして、読み込む。
// Windows では、ブラウザが付けた「どこからDLしたか」の記録（Zone.Identifier）も読む。
// 触れるのは「ダウンロード」フォルダ直下の、シナリオらしい拡張子のファイルだけ。

use serde::Serialize;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

const EXTS: [&str; 7] = ["zip", "wsn", "cab", "lzh", "lha", "7z", "rar"];
const MAX_LIST: usize = 300;
const MAX_READ: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Zone {
    pub host_url: Option<String>,
    pub referrer_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DlItem {
    name: String,
    size: u64,
    modified: u64,
    #[serde(flatten)]
    zone: Zone,
}

fn ext_ok(name: &str) -> bool {
    name.rsplit_once('.').map(|(_, e)| EXTS.contains(&e.to_ascii_lowercase().as_str())).unwrap_or(false)
}

/// ブラウザがファイルに付けた「インターネットから来た」印の中の、DL元のURL
pub fn read_zone(path: &Path) -> Zone {
    #[cfg(windows)]
    {
        let ads = format!("{}:Zone.Identifier", path.display());
        if let Ok(b) = std::fs::read(&ads) {
            let text = if b.starts_with(&[0xff, 0xfe]) {
                let u: Vec<u16> = b[2..].chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
                String::from_utf16_lossy(&u)
            } else {
                String::from_utf8_lossy(&b).to_string()
            };
            return parse_zone(&text);
        }
    }
    let _ = path;
    Zone::default()
}

#[cfg_attr(not(windows), allow(dead_code))]
pub fn parse_zone(text: &str) -> Zone {
    let mut z = Zone::default();
    for line in text.lines() {
        let line = line.trim();
        let ok = |v: &str| v.starts_with("https://") || v.starts_with("http://");
        if let Some(v) = line.strip_prefix("HostUrl=") {
            if ok(v) {
                z.host_url = Some(v.to_string());
            }
        } else if let Some(v) = line.strip_prefix("ReferrerUrl=") {
            if ok(v) {
                z.referrer_url = Some(v.to_string());
            }
        }
    }
    z
}

fn dl_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path().download_dir().map_err(|_| "「ダウンロード」フォルダが見つかりません".to_string())
}

#[tauri::command]
pub fn downloads_list<R: Runtime>(app: AppHandle<R>) -> Result<Vec<DlItem>, String> {
    let dir = dl_dir(&app)?;
    let mut out = vec![];
    for e in std::fs::read_dir(&dir).map_err(|e| format!("「ダウンロード」フォルダを開けません：{e}"))?.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !ext_ok(&name) {
            continue;
        }
        let Ok(md) = e.metadata() else { continue };
        if !md.is_file() {
            continue;
        }
        let modified = md
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        out.push(DlItem { name, size: md.len(), modified, zone: Zone::default() });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    out.truncate(MAX_LIST);
    for it in out.iter_mut() {
        it.zone = read_zone(&dir.join(&it.name));
    }
    Ok(out)
}

#[tauri::command]
pub fn downloads_read<R: Runtime>(app: AppHandle<R>, name: String) -> Result<tauri::ipc::Response, String> {
    if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') || !ext_ok(&name) {
        return Err("このファイルは読めません".into());
    }
    let path = dl_dir(&app)?.join(&name);
    let md = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !md.is_file() || md.len() > MAX_READ {
        return Err("このファイルは読めません".into());
    }
    std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|e| e.to_string())
}

/// ダイアログで選んだファイルなどの、DL元のURL
#[tauri::command]
pub fn zone_info(path: String) -> Zone {
    read_zone(Path::new(&path))
}

#[cfg(test)]
mod tests {
    #[test]
    fn zone() {
        let z = super::parse_zone("[ZoneTransfer]\r\nZoneId=3\r\nReferrerUrl=https://note.com/a/n/n1\r\nHostUrl=https://assets.example/x.zip\r\n");
        assert_eq!(z.referrer_url.as_deref(), Some("https://note.com/a/n/n1"));
        assert_eq!(z.host_url.as_deref(), Some("https://assets.example/x.zip"));
        assert!(super::parse_zone("HostUrl=about:internet").host_url.is_none());
    }
}
