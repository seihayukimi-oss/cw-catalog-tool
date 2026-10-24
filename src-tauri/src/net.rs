//! 作者さんの配布元・同意ページへのアクセス（ダウンロード）。
//!
//! Tauri の http プラグインは、受け取った見出し（ヘッダー）を画面側で組み立て直すため、
//! Googleドライブのように日本語のファイル名をそのまま見出しに入れてくるサイトでは
//! 「Failed to construct 'Headers'」で止まってしまう。そこで、ダウンロードはこちらで行い、
//! 中身は CWCatalog-data\downloads に一時ファイルとして置いて、画面側に場所と見出しだけを渡す
//! （画面側は読んだらすぐ消す）。
use std::collections::HashMap;
use std::io::Write;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;
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
}

#[derive(serde::Serialize)]
pub struct NetResp {
    status: u16,
    url: String,
    content_type: String,
    content_disposition: String,
    content_length: u64,
    set_cookie: Vec<String>,
    /// 中身を置いた一時ファイル（読んだら消す）。うまくいかなかったときは空
    path: String,
    size: u64,
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
pub async fn net_fetch(req: NetReq) -> Result<NetResp, String> {
    let url: reqwest::Url = req.url.parse().map_err(|_| "URLが正しくありません".to_string())?;
    if url.scheme() != "https" && url.scheme() != "http" {
        return Err("http・https だけ読めます".into());
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(10))
        .connect_timeout(Duration::from_secs(30))
        .timeout(Duration::from_secs(req.timeout.unwrap_or(30 * 60).clamp(5, 3 * 60 * 60)))
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())?;
    let method = if req.method.as_deref().map(|m| m.eq_ignore_ascii_case("POST")).unwrap_or(false) {
        reqwest::Method::POST
    } else {
        reqwest::Method::GET
    };
    let mut rb = client.request(method, url);
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
        path: String::new(),
        size: 0,
    };
    if !resp.status().is_success() {
        return Ok(out);
    }
    if content_length > MAX_BYTES {
        return Err("ファイルが大きすぎます".into());
    }
    let dir = crate::portable().downloads_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(format!("net-{}-{}.part", std::process::id(), SEQ.fetch_add(1, Ordering::Relaxed)));
    let mut f = std::fs::File::create(&path).map_err(|e| e.to_string())?;
    let mut size: u64 = 0;
    loop {
        let chunk = match resp.chunk().await {
            Ok(Some(c)) => c,
            Ok(None) => break,
            Err(e) => {
                drop(f);
                let _ = std::fs::remove_file(&path);
                return Err(format!("途中で切れました（{e}）"));
            }
        };
        size += chunk.len() as u64;
        if size > MAX_BYTES {
            drop(f);
            let _ = std::fs::remove_file(&path);
            return Err("ファイルが大きすぎます".into());
        }
        if let Err(e) = f.write_all(&chunk) {
            drop(f);
            let _ = std::fs::remove_file(&path);
            return Err(e.to_string());
        }
    }
    out.path = path.to_string_lossy().to_string();
    out.size = size;
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
