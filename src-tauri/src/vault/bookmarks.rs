use super::{read_bounded_string, read_bounded_string_value};
use crate::now;
use serde_json::{json, Value};

pub(crate) fn get_bookmarks(store: &Value, raw_scope: &str) -> Result<Value, String> {
    let scope = read_bookmark_scope(raw_scope)?;
    Ok(store
        .get("browserBookmarks")
        .and_then(Value::as_array)
        .and_then(|collections| {
            collections.iter().find(|collection| {
                collection
                    .get("scope")
                    .and_then(Value::as_str)
                    .is_some_and(|value| value == scope)
            })
        })
        .and_then(|collection| collection.get("bookmarks"))
        .cloned()
        .unwrap_or_else(|| json!([])))
}

pub(crate) fn save_bookmarks_to_store(
    store: &mut Value,
    raw_scope: &str,
    raw_bookmarks: Value,
) -> Result<Value, String> {
    let scope = read_bookmark_scope(raw_scope)?;
    let bookmarks = read_browser_bookmarks(&raw_bookmarks)?;
    let Some(collections) = store
        .as_object_mut()
        .and_then(|object| object.get_mut("browserBookmarks"))
        .and_then(Value::as_array_mut)
    else {
        return Err("书签分组无效。".to_string());
    };

    let updated_at = now();
    let mut next_collections = Vec::new();
    if !bookmarks.as_array().is_some_and(Vec::is_empty) {
        next_collections.push(json!({
            "scope": scope,
            "bookmarks": bookmarks.clone(),
            "updatedAt": updated_at
        }));
    }
    next_collections.extend(
        collections
            .iter()
            .filter(|collection| {
                collection
                    .get("scope")
                    .and_then(Value::as_str)
                    .is_none_or(|value| value != scope)
            })
            .cloned(),
    );
    *collections = next_collections;
    Ok(bookmarks)
}

fn read_bookmark_scope(value: &str) -> Result<String, String> {
    read_bounded_string(value, "书签范围", 255, true, true, true)
}

fn read_browser_bookmarks(value: &Value) -> Result<Value, String> {
    let Some(bookmarks) = value.as_array() else {
        return Ok(json!([]));
    };
    bookmarks
        .iter()
        .map(read_browser_bookmark)
        .collect::<Result<Vec<_>, _>>()
        .map(Value::Array)
}

fn read_browser_bookmark(value: &Value) -> Result<Value, String> {
    let Some(bookmark) = value.as_object() else {
        return Err("浏览器书签无效。".to_string());
    };
    Ok(json!({
        "id": read_bounded_string_value(bookmark.get("id"), "书签 ID", 128, true, true, true)?,
        "title": read_bounded_string_value(bookmark.get("title"), "书签名称", 200, true, true, true)?,
        "url": read_bounded_string_value(bookmark.get("url"), "书签地址", 4096, true, true, true)?,
        "createdAt": read_bounded_string_value(bookmark.get("createdAt"), "书签创建时间", 64, true, true, true)?,
        "updatedAt": read_bounded_string_value(bookmark.get("updatedAt"), "书签更新时间", 64, true, true, true)?
    }))
}
