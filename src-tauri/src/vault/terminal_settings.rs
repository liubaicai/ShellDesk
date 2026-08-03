use serde_json::{json, Value};

use super::{default_terminal_highlight_rules, random_id, read_bounded_string};

fn bounded_string(value: Option<&Value>, max_length: usize) -> String {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= max_length && !value.contains(['\0', '\r', '\n'])
        })
        .unwrap_or_default()
        .to_string()
}

fn color(value: Option<&Value>, fallback: &str) -> String {
    value
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 7
                && value.starts_with('#')
                && value[1..]
                    .chars()
                    .all(|character| character.is_ascii_hexdigit())
        })
        .unwrap_or(fallback)
        .to_ascii_lowercase()
}

fn escape_regex_literal(value: &str) -> String {
    value
        .chars()
        .flat_map(|character| {
            if matches!(
                character,
                '.' | '+' | '*' | '?' | '^' | '$' | '(' | ')' | '[' | ']' | '{' | '}' | '|' | '\\'
            ) {
                vec!['\\', character]
            } else {
                vec![character]
            }
        })
        .collect()
}

pub(super) fn read_terminal_highlight_rules(
    raw_rules: Option<&Value>,
    legacy_keywords: Option<&Value>,
    fallback: Value,
) -> Value {
    if raw_rules.is_none() {
        if let Some(keywords) = legacy_keywords.and_then(Value::as_str) {
            let pattern = keywords
                .split(',')
                .map(str::trim)
                .filter(|keyword| !keyword.is_empty())
                .take(24)
                .map(escape_regex_literal)
                .collect::<Vec<_>>()
                .join("|");
            if !pattern.is_empty() {
                return json!([{
                    "id": "migrated:keywords", "label": "Migrated keywords",
                    "pattern": pattern, "mode": "regex", "foreground": "#fff2a8",
                    "background": "#6a4f12", "enabled": true, "builtin": false
                }]);
            }
        }
        return fallback;
    }
    let Some(rules) = raw_rules.and_then(Value::as_array) else {
        return fallback;
    };
    let mut output = Vec::new();
    let mut seen_ids = Vec::<String>::new();
    for rule in rules.iter().take(24).filter_map(Value::as_object) {
        let label = bounded_string(rule.get("label"), 80);
        let pattern = bounded_string(rule.get("pattern"), 512);
        if label.is_empty() || pattern.is_empty() {
            continue;
        }
        let raw_id = bounded_string(rule.get("id"), 128);
        let mut id = if raw_id.is_empty() {
            random_id("highlight-rule")
        } else {
            raw_id
        };
        if seen_ids.iter().any(|seen| seen == &id) {
            id = random_id("highlight-rule");
        }
        seen_ids.push(id.clone());
        output.push(json!({
            "id": id, "label": label, "pattern": pattern,
            "mode": if rule.get("mode").and_then(Value::as_str) == Some("regex") { "regex" } else { "literal" },
            "foreground": color(rule.get("foreground"), "#fff2a8"),
            "background": color(rule.get("background"), "#6a4f12"),
            "enabled": rule.get("enabled").and_then(Value::as_bool).unwrap_or(true),
            "builtin": rule.get("builtin").and_then(Value::as_bool).unwrap_or(false)
        }));
    }
    Value::Array(output)
}

pub(super) fn read_terminal_highlight_settings(
    settings: &serde_json::Map<String, Value>,
    defaults: &Value,
) -> Result<(String, Value), String> {
    let keywords = match settings.get("terminalHighlightKeywords") {
        Some(Value::String(value)) => {
            read_bounded_string(value, "终端高亮关键字", 512, false, true, true)?
        }
        _ => defaults["terminalHighlightKeywords"]
            .as_str()
            .unwrap_or("error,warning,failed,denied,exception")
            .to_string(),
    };
    let rules = read_terminal_highlight_rules(
        settings.get("terminalHighlightRules"),
        settings.get("terminalHighlightKeywords"),
        defaults
            .get("terminalHighlightRules")
            .cloned()
            .unwrap_or_else(default_rules),
    );
    Ok((keywords, rules))
}

pub(super) fn default_rules() -> Value {
    default_terminal_highlight_rules()
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Map};

    use super::read_terminal_highlight_settings;

    #[test]
    fn migrates_legacy_highlight_keywords_to_a_regex_rule() {
        let mut settings = Map::new();
        settings.insert(
            "terminalHighlightKeywords".to_string(),
            json!(" error, warning "),
        );
        let defaults = super::super::default_settings();
        let (keywords, rules) = read_terminal_highlight_settings(&settings, &defaults).unwrap();

        assert_eq!(keywords, "error, warning");
        assert_eq!(rules[0]["id"], "migrated:keywords");
        assert_eq!(rules[0]["pattern"], "error|warning");
        assert_eq!(rules[0]["mode"], "regex");
    }

    #[test]
    fn normalizes_structured_rules_and_discards_invalid_entries() {
        let mut settings = Map::new();
        settings.insert(
            "terminalHighlightRules".to_string(),
            json!([
                { "id": "custom", "label": " Failure ", "pattern": "failed|denied", "mode": "regex", "foreground": "#AABBCC", "background": "invalid", "enabled": false },
                { "id": "empty", "label": "", "pattern": "ignored" }
            ]),
        );
        let defaults = super::super::default_settings();
        let (_, rules) = read_terminal_highlight_settings(&settings, &defaults).unwrap();

        assert_eq!(rules.as_array().map(Vec::len), Some(1));
        assert_eq!(rules[0]["label"], "Failure");
        assert_eq!(rules[0]["foreground"], "#aabbcc");
        assert_eq!(rules[0]["background"], "#6a4f12");
        assert_eq!(rules[0]["enabled"], false);
    }
}
