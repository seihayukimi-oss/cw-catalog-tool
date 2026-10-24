// ポータブル版の更新：「更新を確認」ボタンから呼ばれる。
//  1. GitHubのリリースから新しい exe を取ってくる（取りに行けるのはこのリポジトリのリリースだけ）
//  2. リリースのときに付けた署名を、アプリに埋め込んだ公開鍵で確かめる（途中で書き換えられていないか）
//  3. 動いている自分を「〜.old.exe」に名前を変え、新しいものを元の名前で置いて、起動し直す
//  4. 次に起動したとき、古い方を消す

use base64::Engine;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime};

const PUBKEY: &str = include_str!("../update-pubkey.txt");
const RELEASE_PREFIX: &str = "https://github.com/seihayukimi-oss/cw-catalog-tool/releases/download/";
const MAX_SIZE: usize = 200 * 1024 * 1024;

fn b64(s: &str) -> Result<String, String> {
    let raw = base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|_| "署名の形が正しくありません".to_string())?;
    String::from_utf8(raw).map_err(|_| "署名の形が正しくありません".to_string())
}

pub fn verify(data: &[u8], signature: &str) -> Result<(), String> {
    if PUBKEY.trim().is_empty() || PUBKEY.contains("NOT-CONFIGURED") {
        return Err("この版には更新用の鍵が入っていないため、自動では更新できません。GitHubのリリースから新しい CWCatalog.exe を取ってきて置き換えてください".into());
    }
    let pk = minisign_verify::PublicKey::decode(&b64(PUBKEY)?).map_err(|e| format!("公開鍵を読めません：{e}"))?;
    let sig = minisign_verify::Signature::decode(&b64(signature)?).map_err(|e| format!("署名を読めません：{e}"))?;
    pk.verify(data, &sig, true)
        .map_err(|_| "署名が合いません。ダウンロードしたファイルが本物ではない可能性があるので、更新を中止しました".to_string())
}

fn exe_paths() -> Result<(PathBuf, PathBuf, PathBuf), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("exe の場所が分かりません")?.to_path_buf();
    let stem = exe.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "CWCatalog".into());
    Ok((exe.clone(), dir.join(format!("{stem}.new.exe")), dir.join(format!("{stem}.old.exe"))))
}

#[tauri::command]
pub async fn portable_update_install<R: Runtime>(app: AppHandle<R>, url: String, signature: String) -> Result<(), String> {
    if !url.starts_with(RELEASE_PREFIX) {
        return Err("更新のファイルは、このツールのGitHubリリースからしか取りません".into());
    }
    let client = tauri_plugin_http::reqwest::Client::builder()
        .user_agent("CWCatalog-updater")
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| format!("ダウンロードできませんでした：{e}"))?;
    if !res.status().is_success() {
        return Err(format!("ダウンロードできませんでした（{}）", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| format!("ダウンロードできませんでした：{e}"))?;
    if bytes.len() > MAX_SIZE || bytes.len() < 1024 {
        return Err("ダウンロードしたファイルの大きさがおかしいので、中止しました".into());
    }
    verify(&bytes, &signature)?;

    let (exe, new, old) = exe_paths()?;
    std::fs::write(&new, &bytes).map_err(|e| format!("新しい版を置けませんでした（フォルダに書き込めるか確かめてください）：{e}"))?;
    let _ = std::fs::remove_file(&old);
    std::fs::rename(&exe, &old).map_err(|e| {
        let _ = std::fs::remove_file(&new);
        format!("今の版の名前を変えられませんでした：{e}")
    })?;
    if let Err(e) = std::fs::rename(&new, &exe) {
        let _ = std::fs::rename(&old, &exe);
        return Err(format!("新しい版に入れ替えられませんでした：{e}"));
    }
    std::process::Command::new(&exe)
        .arg("--updated")
        .spawn()
        .map_err(|e| format!("新しい版を起動できませんでした。CWCatalog.exe を開き直してください：{e}"))?;
    app.exit(0);
    Ok(())
}

/// 更新の直後に起動されたとき：古い版が終わるのを待ってから続ける（同時に2つ起動しないように）
/// 普段の起動でも、残っている古い版を消しておく
pub fn cleanup_old(after_update: bool) {
    let Ok((_, new, old)) = exe_paths() else { return };
    let _ = std::fs::remove_file(&new);
    if !old.exists() {
        return;
    }
    let tries = if after_update { 50 } else { 1 };
    for _ in 0..tries {
        if std::fs::remove_file(&old).is_ok() || !old.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    }
    // まだ使われていたら、少し後でもう一度
    let old2 = old.clone();
    std::thread::spawn(move || {
        for _ in 0..30 {
            std::thread::sleep(std::time::Duration::from_secs(2));
            if std::fs::remove_file(&old2).is_ok() || !Path::new(&old2).exists() {
                return;
            }
        }
    });
}

#[tauri::command]
pub fn update_key_configured() -> bool {
    !(PUBKEY.trim().is_empty() || PUBKEY.contains("NOT-CONFIGURED"))
}

#[cfg(test)]
mod tests {
    #[test]
    fn signature() {
        let data = include_bytes!("../tests-data/signed.txt");
        let sig = include_str!("../tests-data/signed.txt.sig");
        assert!(super::verify(data, sig).is_ok());
        let mut bad = data.to_vec();
        bad[0] ^= 1;
        assert!(super::verify(&bad, sig).is_err());
    }
}

/// GitHub Actions で、登録した秘密鍵で署名したファイルを、埋め込んだ公開鍵で確かめられるか（鍵の組み合わせの確認）
#[cfg(test)]
mod ci_key {
    #[test]
    fn registered_key_matches() {
        let Ok(path) = std::env::var("CW_CI_SIGNED") else { return };
        let data = std::fs::read(&path).expect("署名した試験用ファイル");
        let sig = std::fs::read_to_string(format!("{path}.sig")).expect("署名");
        super::verify(&data, &sig).expect("登録した秘密鍵と、アプリの公開鍵が組になっていません");
    }
}
