use serde_json::Value;
use std::path::Path;

pub(super) fn default_transfer_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|value| value.to_string_lossy().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "transfer".to_string())
}

pub(super) fn remote_file_name(path: &str, fallback: &str) -> String {
    path.replace('\\', "/")
        .split('/')
        .rfind(|part| !part.is_empty())
        .unwrap_or(fallback)
        .to_string()
}

pub(super) fn sanitize_local_file_name(file_name: &str, fallback: &str) -> String {
    let safe_name = file_name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>()
        .trim_end_matches(['.', ' '])
        .trim()
        .to_string();
    if safe_name.is_empty() || is_windows_reserved_local_file_name(&safe_name) {
        fallback.to_string()
    } else {
        safe_name
    }
}

pub(super) fn upload_remote_name(item: &Value, local_path: &Path) -> String {
    let fallback_name = remote_file_name(&local_path.to_string_lossy(), "upload");
    let raw_name = item
        .get("remoteName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback_name);
    sanitize_local_file_name(raw_name, "upload")
}

fn is_windows_reserved_local_file_name(file_name: &str) -> bool {
    let stem = file_name
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    matches!(
        stem.as_str(),
        "con"
            | "prn"
            | "aux"
            | "nul"
            | "com1"
            | "com2"
            | "com3"
            | "com4"
            | "com5"
            | "com6"
            | "com7"
            | "com8"
            | "com9"
            | "lpt1"
            | "lpt2"
            | "lpt3"
            | "lpt4"
            | "lpt5"
            | "lpt6"
            | "lpt7"
            | "lpt8"
            | "lpt9"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_transfer_name_uses_file_name_or_fallback() {
        assert_eq!(default_transfer_name("/var/log/syslog"), "syslog");
        assert_eq!(default_transfer_name("/"), "transfer");
        assert_eq!(default_transfer_name(""), "transfer");
    }

    #[test]
    fn remote_file_name_handles_unix_and_windows_separators() {
        assert_eq!(remote_file_name("/var/log/syslog", "fallback"), "syslog");
        assert_eq!(
            remote_file_name("C:\\Temp\\report.txt", "fallback"),
            "report.txt"
        );
        assert_eq!(remote_file_name("/var/log/", "fallback"), "log");
        assert_eq!(remote_file_name("", "fallback"), "fallback");
    }

    #[test]
    fn sanitize_local_file_name_replaces_invalid_characters_and_trims_suffixes() {
        assert_eq!(
            sanitize_local_file_name(r#"bad<>:"/\|?*.txt"#, "fallback"),
            "bad_________.txt"
        );
        assert_eq!(
            sanitize_local_file_name(" report.txt. ", "fallback"),
            "report.txt"
        );
        assert_eq!(
            sanitize_local_file_name("line\nbreak.txt", "fallback"),
            "line_break.txt"
        );
    }

    #[test]
    fn sanitize_local_file_name_rejects_empty_and_windows_reserved_names() {
        assert_eq!(sanitize_local_file_name("...", "fallback"), "fallback");
        assert_eq!(sanitize_local_file_name("CON", "fallback"), "fallback");
        assert_eq!(sanitize_local_file_name("com1.txt", "fallback"), "fallback");
        assert_eq!(
            sanitize_local_file_name("normal.txt", "fallback"),
            "normal.txt"
        );
    }

    #[test]
    fn upload_remote_name_prefers_sanitized_remote_name_then_local_path() {
        let item = json!({ "remoteName": " unsafe:name.txt " });
        assert_eq!(
            upload_remote_name(&item, Path::new(r"C:\Temp\local.txt")),
            "unsafe_name.txt"
        );

        let item = json!({ "remoteName": "" });
        assert_eq!(
            upload_remote_name(&item, Path::new(r"C:\Temp\local.txt")),
            "local.txt"
        );

        let item = json!({ "remoteName": "NUL" });
        assert_eq!(upload_remote_name(&item, Path::new("local.txt")), "upload");
    }
}
