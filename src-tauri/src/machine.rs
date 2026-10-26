//! このパソコン・このWindowsユーザーの目印（年齢確認を、パソコンが変わったら聞き直すため）。
//! 中身は、Windowsが持っている「このパソコンの番号」（MachineGuid）とユーザー名・コンピューター名を
//! まぜて短くしたもの。元には戻せず、どこにも送らない（CWCatalog-data の中で比べるだけ）。

fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[cfg(windows)]
fn machine_guid() -> String {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_64KEY};
    use winreg::RegKey;
    RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Cryptography", KEY_READ | KEY_WOW64_64KEY)
        .and_then(|k| k.get_value::<String, _>("MachineGuid"))
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn machine_guid() -> String {
    std::fs::read_to_string("/etc/machine-id").unwrap_or_default().trim().to_string()
}

pub fn key() -> String {
    let user = std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_default();
    let host = std::env::var("COMPUTERNAME").or_else(|_| std::env::var("HOSTNAME")).unwrap_or_default();
    let src = format!("cwcatalog|{}|{}|{}", machine_guid(), user, host);
    format!("{:016x}", fnv1a(&src))
}

#[tauri::command]
pub fn machine_key() -> String {
    key()
}

#[cfg(test)]
mod tests {
    #[test]
    fn stable() {
        assert_eq!(super::key(), super::key());
        assert_eq!(super::fnv1a("a"), 0xaf63dc4c8601ec8c);
    }
}
