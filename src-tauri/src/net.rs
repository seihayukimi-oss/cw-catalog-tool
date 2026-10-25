//! 作者さんの配布元・同意ページへのアクセス（ダウンロード）。
//!
//! Tauri の http プラグインは、受け取った見出し（ヘッダー）を画面側で組み立て直すため、
//! Googleドライブのように日本語のファイル名をそのまま見出しに入れてくるサイトでは
//! 「Failed to construct 'Headers'」で止まってしまう。そこで、ダウンロードはこちらで行い、
//! 受け取った中身はパソコンに書き込まず、メモリの中だけに置いて、画面側が `net_take` で引き取る
//! （インストールすると決めたものだけが、あとで保存先に書き込まれる）。
//! 中身を確かめるため、ファイルの一部だけ（Range）を読むこともできる。
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri_plugin_http::reqwest;

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const UA: &str = "CWCatalogTool (+https://github.com/seihayukimi-oss/cw-catalog-tool)";
static SEQ: AtomicU32 = AtomicU32::new(0);

#[derive(serde::Deserialize)]
pub struct NetReq {
    url: String,
    method: Option<String>,
    body: Option<String>,
    headers: Option<HashMap<String, String>>,
    /// 待つ長さ（秒）。なければ30分（大きいファイル用）
    timeout: Option<u64>,
    /// 進み具合を知らせるときの番号（画面側で付ける）。なければ知らせない
    progress: Option<u32>,
    /// ここまで読んだら止める（目次だけ読みたいときなど）。なければ最後まで
    max: Option<u64>,
}

/// 受け取った中身の置き場（メモリの中だけ）。画面側が net_take で引き取ると消える
fn mem() -> &'static Mutex<HashMap<u32, Vec<u8>>> {
    static M: OnceLock<Mutex<HashMap<u32, Vec<u8>>>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 受け取った中身を引き取る（1回だけ。引き取ったらメモリから消える）
#[tauri::command]
pub fn net_take(id: u32) -> tauri::ipc::Response {
    let v = mem().lock().map(|mut m| m.remove(&id).unwrap_or_default()).unwrap_or_default();
    tauri::ipc::Response::new(v)
}

#[derive(Clone, serde::Serialize)]
struct Progress {
    id: u32,
    got: u64,
    total: u64,
}

/// 通信の部品は1つを使い回す（同じサイトへの続けての通信が速くなる）
fn client() -> Result<&'static reqwest::Client, String> {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(c) = C.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(30))
        .pool_max_idle_per_host(8)
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(C.get_or_init(|| c))
}

/// 前の版で使っていた一時ファイルが残っていたら消す（起動したときに呼ぶ）
pub fn cleanup_parts() {
    let dir = crate::portable().downloads_dir();
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with("net-") && name.ends_with(".part") {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }
}

#[derive(serde::Serialize)]
pub struct NetResp {
    status: u16,
    url: String,
    content_type: String,
    content_disposition: String,
    content_length: u64,
    set_cookie: Vec<String>,
    /// 一部だけ読んだときの「bytes 始め-終わり/全体」
    content_range: String,
    /// 中身の引き取り番号（net_take に渡す）。中身が無いときは 0
    id: u32,
    size: u64,
    /// max で途中で止めたとき true
    truncated: bool,
}

/// 見出しの値を文字にする。UTF-8 ならそのまま、違えば1バイト1文字で読む
fn header_text(v: &reqwest::header::HeaderValue) -> String {
    let b = v.as_bytes();
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|&c| c as char).collect(),
    }
}

fn get(h: &reqwest::header::HeaderMap, name: &str) -> String {
    h.get(name).map(header_text).unwrap_or_default()
}

#[tauri::command]
pub async fn net_fetch(app: tauri::AppHandle, req: NetReq) -> Result<NetResp, String> {
    let url: reqwest::Url = req.url.parse().map_err(|_| "URLが正しくありません".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("http・https だけ読めます".into());
    }
    let method = if req.method.as_deref().map(|m| m.eq_ignore_ascii_case("POST")).unwrap_or(false) {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };
    let mut rb = client()?
        .request(method, url)
        .timeout(Duration::from_secs(req.timeout.unwrap_or(30 * 60).clamp(5, 3 * 60 * 60)));
    for (k, v) in req.headers.unwrap_or_default() {
        let (Ok(name), Ok(value)) = (
            reqwest::header::HeaderName::from_bytes(k.as_bytes()),
            reqwest::header::HeaderValue::from_bytes(v.as_bytes()),
        ) else {
            continue;
        };
        rb = rb.header(name, value);
    }
    if let Some(b) = req.body {
        rb = rb.body(b);
    }
    let mut resp = rb.send().await.map_err(|e| format!("つながりませんでした（{e}）"))?;
    let status = resp.status().as_u16();
    let final_url = resp.url().to_string();
    let h = resp.headers().clone();
    let set_cookie = h.get_all("set-cookie").iter().map(header_text).collect();
    let content_length = resp.content_length().unwrap_or(0);
    let mut out = NetResp {
        status,
        url: final_url,
        content_type: get(&h, "content-type"),
        content_disposition: get(&h, "content-disposition"),
        content_length,
        set_cookie,
        content_range: get(&h, "content-range"),
        id: 0,
        size: 0,
        truncated: false,
    };
    if !resp.status().is_success() {
        return Ok(out);
    }
    let max = req.max.unwrap_or(MAX_BYTES).min(MAX_BYTES);
    if content_length > MAX_BYTES && req.max.is_none() {
        return Err("ファイルが大きすぎます".into());
    }
    let mut buf: Vec<u8> = Vec::with_capacity(content_length.min(max).min(256 * 1024 * 1024) as usize);
    let mut last = Instant::now();
    let tell = |got: u64| {
        if let Some(id) = req.progress {
            let _ = app.emit_to("main", "cw-net-progress", Progress { id, got, total: content_length });
        }
    };
    tell(0);
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => return Err(format!("途中で切れました（{e}）")),
        };
        let room = (max - buf.len() as u64) as usize;
        if chunk.len() > room {
            buf.extend_from_slice(&chunk[..room]);
            out.truncated = true;
            break;
        }
        buf.extend_from_slice(&chunk);
        if last.elapsed() >= Duration::from_millis(150) {
            last = Instant::now();
            tell(buf.len() as u64);
        }
    }
    if out.truncated && req.max.is_none() {
        return Err("ファイルが大きすぎます".into());
    }
    out.size = buf.len() as u64;
    tell(out.size);
    if !buf.is_empty() {
        let id = SEQ.fetch_add(1, Ordering::Relaxed).wrapping_add(1).max(1);
        mem().lock().map_err(|_| "メモリの置き場が使えません".to_string())?.insert(id, buf);
        out.id = id;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn header_utf8_and_latin1() {
        let v = reqwest::header::HeaderValue::from_bytes("attachment; filename=\"迷える.zip\"".as_bytes()).unwrap();
        assert_eq!(header_text(&v), "attachment; filename=\"迷える.zip\"");
        let v = reqwest::header::HeaderValue::from_bytes(&[b'a', 0xE9]).unwrap();
        assert_eq!(header_text(&v), "aé");
    }
}
