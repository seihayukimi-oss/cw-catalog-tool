// Windowsとのつなぎこみ（設定の「登録する」を押した人だけ）：
//  ・.wsn を「プログラムから開く」の候補に出す（いつもこれで開く、の設定はWindowsの決まりで本人が選ぶ）
//  ・zip・wsn・cab・lzh・7z の右クリックに「CWカタログで開く」を足す
//  ・cwcatalog:// のリンク（サイトの「CWカタログで入れる」）でアプリを開く
// 書き込むのは「自分のユーザー用」の場所（HKEY_CURRENT_USER\Software\Classes）だけ。管理者の許可は要らない。

use serde::Serialize;

pub const PROTOCOL: &str = "cwcatalog";
pub const OPEN_EXTS: [&str; 6] = ["zip", "wsn", "cab", "lzh", "lha", "7z"];

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AssocStatus {
    supported: bool,
    registered: bool,
    /// 登録はあるが、exe の場所が今と違う（フォルダを動かした）
    moved: bool,
}

/// 起動時の引数から、開くファイルとリンクを取り出す
pub fn open_args(args: &[String]) -> Vec<String> {
    args.iter()
        .skip(1)
        .filter(|a| !a.starts_with("--"))
        .filter(|a| {
            let l = a.to_ascii_lowercase();
            l.starts_with(&format!("{PROTOCOL}:")) || OPEN_EXTS.iter().any(|e| l.ends_with(&format!(".{e}")))
        })
        .take(50)
        .cloned()
        .collect()
}

#[cfg(windows)]
mod imp {
    use super::*;
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;

    const CLASSES: &str = r"Software\Classes";
    const PROGID: &str = "CWCatalog.wsn";
    const MENU: &str = "CWCatalog";

    fn exe() -> Result<String, String> {
        std::env::current_exe().map(|p| p.to_string_lossy().to_string()).map_err(|e| e.to_string())
    }
    fn cmd(exe: &str) -> String {
        format!("\"{exe}\" \"%1\"")
    }
    fn set(root: &RegKey, path: &str, name: &str, value: &str) -> std::io::Result<()> {
        let (k, _) = root.create_subkey(path)?;
        k.set_value(name, &value.to_string())
    }

    pub fn status() -> AssocStatus {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let key = format!(r"{CLASSES}\{PROTOCOL}\shell\open\command");
        match hkcu.open_subkey(&key).and_then(|k| k.get_value::<String, _>("")) {
            Ok(v) => AssocStatus { supported: true, registered: true, moved: exe().map(|e| v != cmd(&e)).unwrap_or(false) },
            Err(_) => AssocStatus { supported: true, registered: false, moved: false },
        }
    }

    pub fn register() -> Result<(), String> {
        let exe = exe()?;
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let icon = format!("\"{exe}\",0");
        let e = |r: std::io::Result<()>| r.map_err(|e| format!("Windowsへの登録に失敗しました：{e}"));
        // cwcatalog:// リンク
        e(set(&hkcu, &format!(r"{CLASSES}\{PROTOCOL}"), "", "URL:CWカタログ"))?;
        e(set(&hkcu, &format!(r"{CLASSES}\{PROTOCOL}"), "URL Protocol", ""))?;
        e(set(&hkcu, &format!(r"{CLASSES}\{PROTOCOL}\DefaultIcon"), "", &icon))?;
        e(set(&hkcu, &format!(r"{CLASSES}\{PROTOCOL}\shell\open\command"), "", &cmd(&exe)))?;
        // .wsn を「プログラムから開く」の候補に
        e(set(&hkcu, &format!(r"{CLASSES}\{PROGID}"), "", "CardWirth シナリオ（WSN）"))?;
        e(set(&hkcu, &format!(r"{CLASSES}\{PROGID}\DefaultIcon"), "", &icon))?;
        e(set(&hkcu, &format!(r"{CLASSES}\{PROGID}\shell\open\command"), "", &cmd(&exe)))?;
        e(set(&hkcu, &format!(r"{CLASSES}\.wsn\OpenWithProgids"), PROGID, ""))?;
        // 右クリックの「CWカタログで開く」
        for ext in OPEN_EXTS {
            let base = format!(r"{CLASSES}\SystemFileAssociations\.{ext}\shell\{MENU}");
            e(set(&hkcu, &base, "", "CWカタログで開く"))?;
            e(set(&hkcu, &base, "Icon", &icon))?;
            e(set(&hkcu, &format!(r"{base}\command"), "", &cmd(&exe)))?;
        }
        Ok(())
    }

    pub fn unregister() -> Result<(), String> {
        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        let del = |p: String| {
            let _ = hkcu.delete_subkey_all(p);
        };
        del(format!(r"{CLASSES}\{PROTOCOL}"));
        del(format!(r"{CLASSES}\{PROGID}"));
        if let Ok(k) = hkcu.open_subkey_with_flags(format!(r"{CLASSES}\.wsn\OpenWithProgids"), winreg::enums::KEY_ALL_ACCESS) {
            let _ = k.delete_value(PROGID);
        }
        for ext in OPEN_EXTS {
            del(format!(r"{CLASSES}\SystemFileAssociations\.{ext}\shell\{MENU}"));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    use super::*;
    pub fn status() -> AssocStatus {
        AssocStatus::default()
    }
    pub fn register() -> Result<(), String> {
        Err("Windowsだけの機能です".into())
    }
    pub fn unregister() -> Result<(), String> {
        Ok(())
    }
}

#[tauri::command]
pub fn assoc_status() -> AssocStatus {
    imp::status()
}

#[tauri::command]
pub fn assoc_register() -> Result<(), String> {
    imp::register()
}

#[tauri::command]
pub fn assoc_unregister() -> Result<(), String> {
    imp::unregister()
}

#[cfg(test)]
mod tests {
    #[test]
    fn args() {
        let a: Vec<String> = ["CWCatalog.exe", "--updated", "D:\\x\\森.WSN", "cwcatalog://install?url=x", "D:\\x\\a.txt"].iter().map(|s| s.to_string()).collect();
        assert_eq!(super::open_args(&a), vec!["D:\\x\\森.WSN".to_string(), "cwcatalog://install?url=x".to_string()]);
    }
}
