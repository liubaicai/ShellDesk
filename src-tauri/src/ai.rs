use chrono::{TimeZone, Utc};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::{collections::HashSet, time::Duration};
use tauri::Emitter;

use crate::error_string;

const ANTHROPIC_API_VERSION: &str = "2023-06-01";
const MODEL_LIST_TIMEOUT_SECS: u64 = 20;
const CHAT_TIMEOUT_SECS: u64 = 60;
const CHAT_STREAM_TIMEOUT_SECS: u64 = 120;
const WEB_SEARCH_TIMEOUT_SECS: u64 = 30;
const MAX_AI_MODEL_NAME_LENGTH: usize = 200;
const MAX_AI_MESSAGE_COUNT: usize = 40;
const MAX_AI_MESSAGE_LENGTH: usize = 120000;
const MAX_AI_STREAM_ID_LENGTH: usize = 80;
const MAX_AI_SSE_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_WEB_SEARCH_QUERY_LENGTH: usize = 1000;
const MAX_WEB_SEARCH_SNIPPET_LENGTH: usize = 1200;

struct AiModelListRequest {
    api_format: String,
    api_base_url: String,
    api_key: String,
}

#[derive(Clone)]
struct AiChatMessage {
    role: String,
    content: String,
    tool_call_id: Option<String>,
    tool_name: Option<String>,
    tool_calls: Vec<Value>,
}

#[derive(Clone)]
struct AiChatTool {
    name: String,
    description: String,
    parameters: Value,
}

#[derive(Clone)]
struct AiChatRequest {
    api_format: String,
    api_base_url: String,
    api_key: String,
    model: String,
    messages: Vec<AiChatMessage>,
    tools: Vec<AiChatTool>,
    temperature: f64,
}

#[derive(Clone)]
struct AiChatStreamRequest {
    chat: AiChatRequest,
    stream_id: String,
}

struct WebSearchRequest {
    provider: String,
    api_base_url: String,
    api_key: String,
    query: String,
    max_results: usize,
}

#[derive(Default)]
struct OpenAiStreamToolCallDelta {
    id: String,
    name: String,
    arguments: String,
}

pub(crate) async fn ai_list_models(args: Vec<Value>) -> Result<Value, String> {
    list_ai_models(args.first().cloned().unwrap_or_else(|| json!({}))).await
}

pub(crate) async fn ai_chat(args: Vec<Value>) -> Result<Value, String> {
    request_ai_chat(args.first().cloned().unwrap_or_else(|| json!({}))).await
}

pub(crate) async fn ai_chat_stream(
    window: &tauri::Window,
    args: Vec<Value>,
) -> Result<Value, String> {
    request_ai_chat_stream(window, args.first().cloned().unwrap_or_else(|| json!({}))).await
}

pub(crate) async fn ai_web_search(args: Vec<Value>) -> Result<Value, String> {
    request_web_search(args.first().cloned().unwrap_or_else(|| json!({}))).await
}

fn read_limited_string(
    value: Option<&Value>,
    field_label: &str,
    max_len: usize,
    trim: bool,
    required: bool,
) -> Result<String, String> {
    let raw = value
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{field_label}不能为空。"))?;
    let output = if trim { raw.trim() } else { raw }.to_string();
    if required && output.trim().is_empty() {
        return Err(format!("{field_label}不能为空。"));
    }
    if output.chars().count() > max_len {
        return Err(format!("{field_label}过长。"));
    }
    Ok(output)
}

fn read_ai_api_base_url(value: Option<&Value>) -> Result<String, String> {
    let api_base_url = read_limited_string(value, "AI API 地址", 2048, true, true)?;
    let mut parsed =
        reqwest::Url::parse(&api_base_url).map_err(|_| "AI API 地址无效。".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("AI API 地址只支持 http 或 https。".to_string());
    }
    if parsed.query().is_some() || parsed.fragment().is_some() {
        return Err("AI API 地址不能包含查询参数或片段。".to_string());
    }
    let normalized_path = parsed.path().trim_end_matches('/').to_string();
    parsed.set_path(&normalized_path);
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn read_ai_model_list_request(raw_request: Value) -> Result<AiModelListRequest, String> {
    let object = raw_request
        .as_object()
        .ok_or_else(|| "AI 模型列表请求无效。".to_string())?;
    let provider = object.get("provider").and_then(Value::as_str).unwrap_or("");
    let fallback_format = if provider == "anthropic" {
        "anthropic"
    } else {
        "openai"
    };
    let api_format = match object.get("apiFormat").and_then(Value::as_str) {
        Some("anthropic") => "anthropic",
        Some("openai") => "openai",
        _ => fallback_format,
    }
    .to_string();
    let api_base_url = read_ai_api_base_url(object.get("apiBaseUrl"))?;
    let api_key = read_limited_string(object.get("apiKey"), "AI API 密钥", 4096, true, false)
        .unwrap_or_default();
    if api_format == "anthropic" && api_key.is_empty() {
        return Err("请输入AI API 密钥。".to_string());
    }
    Ok(AiModelListRequest {
        api_format,
        api_base_url,
        api_key,
    })
}

fn read_ai_chat_message(raw_message: &Value) -> Result<AiChatMessage, String> {
    let object = raw_message
        .as_object()
        .ok_or_else(|| "SD-Agent 消息无效。".to_string())?;
    let role = match object.get("role").and_then(Value::as_str) {
        Some("assistant") => "assistant",
        Some("system") => "system",
        Some("tool") => "tool",
        _ => "user",
    }
    .to_string();
    let content = read_limited_string(
        object.get("content"),
        "SD-Agent 消息内容",
        MAX_AI_MESSAGE_LENGTH,
        false,
        true,
    )?;
    let tool_call_id = read_limited_string(
        object.get("toolCallId"),
        "SD-Agent 工具调用 ID",
        200,
        true,
        false,
    )
    .ok()
    .filter(|value| !value.is_empty());
    let tool_name = read_limited_string(
        object.get("toolName"),
        "SD-Agent 工具名称",
        120,
        true,
        false,
    )
    .ok()
    .filter(|value| !value.is_empty());
    let tool_calls = object
        .get("toolCalls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .take(16)
        .filter_map(|tool_call| {
            let object = tool_call.as_object()?;
            let id = object.get("id").and_then(Value::as_str)?.trim();
            let name = object.get("name").and_then(Value::as_str)?.trim();
            if id.is_empty() || name.is_empty() {
                return None;
            }
            let arguments = object
                .get("arguments")
                .cloned()
                .filter(Value::is_object)
                .unwrap_or_else(|| json!({}));
            Some(json!({
                "id": id,
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": arguments.to_string()
                }
            }))
        })
        .collect();
    Ok(AiChatMessage {
        role,
        content,
        tool_call_id,
        tool_name,
        tool_calls,
    })
}

fn read_ai_chat_tool(raw_tool: &Value) -> Result<AiChatTool, String> {
    let object = raw_tool
        .as_object()
        .ok_or_else(|| "SD-Agent 工具定义无效。".to_string())?;
    let name = read_limited_string(object.get("name"), "SD-Agent 工具名称", 120, true, true)?;
    let description = read_limited_string(
        object.get("description"),
        "SD-Agent 工具描述",
        2000,
        true,
        false,
    )
    .unwrap_or_default();
    let parameters = object
        .get("parameters")
        .cloned()
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({ "type": "object", "properties": {} }));

    Ok(AiChatTool {
        name,
        description,
        parameters,
    })
}

fn read_ai_chat_request(raw_request: Value) -> Result<AiChatRequest, String> {
    let object = raw_request
        .as_object()
        .ok_or_else(|| "AI 模型列表请求无效。".to_string())?;
    let base = read_ai_model_list_request(Value::Object(object.clone()))?;
    let model = read_limited_string(
        object.get("model"),
        "SD-Agent 模型",
        MAX_AI_MODEL_NAME_LENGTH,
        true,
        true,
    )?;
    let raw_messages = object
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let start = raw_messages.len().saturating_sub(MAX_AI_MESSAGE_COUNT);
    let messages = raw_messages[start..]
        .iter()
        .map(read_ai_chat_message)
        .collect::<Result<Vec<_>, _>>()?;
    if messages.is_empty() {
        return Err("SD-Agent 消息不能为空。".to_string());
    }
    let raw_tools = object
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let tools = raw_tools
        .iter()
        .take(32)
        .map(read_ai_chat_tool)
        .collect::<Result<Vec<_>, _>>()?;
    let temperature = object
        .get("temperature")
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite() && *value >= 0.0 && *value <= 2.0)
        .unwrap_or(0.2);
    Ok(AiChatRequest {
        api_format: base.api_format,
        api_base_url: base.api_base_url,
        api_key: base.api_key,
        model,
        messages,
        tools,
        temperature,
    })
}

fn read_ai_chat_stream_request(raw_request: Value) -> Result<AiChatStreamRequest, String> {
    let object = raw_request
        .as_object()
        .ok_or_else(|| "AI 模型列表请求无效。".to_string())?;
    let chat = read_ai_chat_request(Value::Object(object.clone()))?;
    let stream_id = read_limited_string(
        object.get("streamId"),
        "SD-Agent 流式请求 ID",
        MAX_AI_STREAM_ID_LENGTH,
        true,
        true,
    )?;
    Ok(AiChatStreamRequest { chat, stream_id })
}

fn read_web_search_request(raw_request: Value) -> Result<WebSearchRequest, String> {
    let object = raw_request
        .as_object()
        .ok_or_else(|| "网络搜索请求无效。".to_string())?;
    let provider = match object.get("provider").and_then(Value::as_str) {
        Some("exa") => "exa",
        Some("zhipu") => "zhipu",
        _ => "tavily",
    }
    .to_string();
    let fallback_api_base_url = default_web_search_api_base_url(&provider);
    let api_base_url = object
        .get("apiBaseUrl")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(&fallback_api_base_url)
        .trim_end_matches('/')
        .to_string();
    let parsed =
        reqwest::Url::parse(&api_base_url).map_err(|_| "网络搜索 API 地址无效。".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("网络搜索 API 地址只支持 http 或 https。".to_string());
    }
    let api_key = read_limited_string(object.get("apiKey"), "网络搜索 API 密钥", 8192, true, true)?;
    let query = read_limited_string(
        object.get("query"),
        "网络搜索关键词",
        MAX_WEB_SEARCH_QUERY_LENGTH,
        true,
        true,
    )?;
    let max_results = object
        .get("maxResults")
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_i64().and_then(|number| u64::try_from(number).ok()))
        })
        .filter(|value| (1..=20).contains(value))
        .unwrap_or(5) as usize;

    Ok(WebSearchRequest {
        provider,
        api_base_url,
        api_key,
        query,
        max_results,
    })
}

fn append_api_path(api_base_url: &str, path_suffix: &str) -> String {
    format!("{}{}", api_base_url.trim_end_matches('/'), path_suffix)
}

fn api_base_is_version_path(api_base_url: &str) -> bool {
    reqwest::Url::parse(api_base_url)
        .ok()
        .map(|url| {
            let segments = url
                .path_segments()
                .map(|segments| segments.collect::<Vec<_>>())
                .unwrap_or_default();
            let is_version_segment = |segment: &str| {
                let digits = segment.strip_prefix('v').unwrap_or_default();
                !digits.is_empty() && digits.chars().all(|ch| ch.is_ascii_digit())
            };
            match segments.as_slice() {
                [.., version, "beta"] => is_version_segment(version),
                [.., version] => is_version_segment(version),
                _ => false,
            }
        })
        .unwrap_or(false)
}

fn create_models_endpoint(api_format: &str, api_base_url: &str) -> String {
    if api_base_url.trim_end_matches('/').ends_with("/models") {
        return api_base_url.to_string();
    }
    if api_format == "anthropic" {
        if api_base_is_version_path(api_base_url) {
            return append_api_path(api_base_url, "/models");
        }
        return append_api_path(api_base_url, "/v1/models");
    }
    append_api_path(api_base_url, "/models")
}

fn create_chat_endpoint(api_format: &str, api_base_url: &str) -> String {
    if api_format == "anthropic" {
        if api_base_url.trim_end_matches('/').ends_with("/messages") {
            return api_base_url.to_string();
        }
        if api_base_is_version_path(api_base_url) {
            return append_api_path(api_base_url, "/messages");
        }
        return append_api_path(api_base_url, "/v1/messages");
    }
    if api_base_url
        .trim_end_matches('/')
        .ends_with("/chat/completions")
    {
        return api_base_url.to_string();
    }
    append_api_path(api_base_url, "/chat/completions")
}

fn parse_json_response(text: &str) -> Option<Value> {
    if text.trim().is_empty() {
        return None;
    }
    serde_json::from_str(text).ok()
}

fn read_error_message(payload: Option<&Value>, fallback_text: &str) -> String {
    if let Some(error) = payload.and_then(|payload| payload.get("error")) {
        if let Some(message) = error
            .get("message")
            .or_else(|| error.get("error").and_then(|value| value.get("message")))
            .or_else(|| error.get("type"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
        {
            return message.trim().to_string();
        }
        if let Some(message) = error.as_str().filter(|value| !value.trim().is_empty()) {
            return message.trim().to_string();
        }
    }
    if let Some(message) = payload
        .and_then(|payload| payload.get("message"))
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        return message.trim().to_string();
    }
    let fallback = fallback_text.trim();
    if !fallback.is_empty() {
        return fallback.chars().take(500).collect();
    }
    "模型列表请求失败。".to_string()
}

fn ai_text_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.trim().to_string(),
        Some(Value::Number(value)) => value.to_string(),
        _ => String::new(),
    }
}

fn ai_content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(value)) => value.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::String(value) => value.clone(),
                Value::Object(object) => object
                    .get("text")
                    .or_else(|| object.get("content"))
                    .or_else(|| object.get("input_text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string(),
                _ => String::new(),
            })
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn normalize_model_entry(raw_model: &Value) -> Option<Value> {
    if raw_model.is_string() || raw_model.is_number() {
        let model_id = ai_text_value(Some(raw_model));
        if model_id.is_empty() {
            return None;
        }
        return Some(json!({ "id": model_id, "name": model_id }));
    }
    let object = raw_model.as_object()?;
    let model_id = ai_text_value(object.get("id"))
        .if_empty(ai_text_value(object.get("name")))
        .if_empty(ai_text_value(object.get("model")))
        .if_empty(ai_text_value(object.get("slug")));
    if model_id.is_empty() {
        return None;
    }
    let model_name = ai_text_value(object.get("display_name"))
        .if_empty(ai_text_value(object.get("displayName")))
        .if_empty(ai_text_value(object.get("label")))
        .if_empty(ai_text_value(object.get("name")))
        .if_empty(model_id.clone());
    let owned_by = ai_text_value(object.get("owned_by"))
        .if_empty(ai_text_value(object.get("ownedBy")))
        .if_empty(ai_text_value(object.get("owner")))
        .if_empty(ai_text_value(object.get("type")));
    let created_at = object
        .get("created_at")
        .or_else(|| object.get("created"))
        .and_then(|value| match value {
            Value::String(value) if !value.trim().is_empty() => Some(value.trim().to_string()),
            Value::Number(value) => value
                .as_i64()
                .filter(|value| *value > 0)
                .and_then(|value| Utc.timestamp_opt(value, 0).single())
                .map(|value| value.to_rfc3339()),
            _ => None,
        });
    let mut output = json!({ "id": model_id, "name": model_name });
    if let Some(created_at) = created_at {
        output["createdAt"] = json!(created_at);
    }
    if !owned_by.is_empty() {
        output["ownedBy"] = json!(owned_by);
    }
    Some(output)
}

fn parse_model_list(payload: &Value) -> Vec<Value> {
    let raw_models = payload
        .as_array()
        .cloned()
        .or_else(|| payload.get("data").and_then(Value::as_array).cloned())
        .or_else(|| payload.get("models").and_then(Value::as_array).cloned())
        .or_else(|| payload.get("items").and_then(Value::as_array).cloned())
        .or_else(|| payload.get("model_ids").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    raw_models
        .iter()
        .take(1000)
        .filter_map(normalize_model_entry)
        .filter(|model| {
            let id = model
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            !id.is_empty() && seen.insert(id)
        })
        .collect()
}

fn read_openai_chat_content_optional(payload: &Value) -> String {
    let first_choice = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first());
    let content = first_choice
        .and_then(|choice| {
            choice
                .get("message")
                .and_then(|message| message.get("content"))
        })
        .or_else(|| first_choice.and_then(|choice| choice.get("text")))
        .or_else(|| {
            first_choice
                .and_then(|choice| choice.get("delta").and_then(|delta| delta.get("content")))
        })
        .or_else(|| payload.get("output_text"));

    ai_content_text(content)
}

fn parse_openai_tool_arguments(value: Option<&Value>) -> Value {
    match value {
        Some(Value::String(raw)) => serde_json::from_str(raw).unwrap_or_else(|_| json!({})),
        Some(Value::Object(_)) => value.cloned().unwrap_or_else(|| json!({})),
        _ => json!({}),
    }
}

fn read_openai_tool_calls(payload: &Value) -> Vec<Value> {
    let Some(first_choice) = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
    else {
        return Vec::new();
    };
    let tool_calls = first_choice
        .get("message")
        .and_then(|message| message.get("tool_calls"))
        .or_else(|| first_choice.get("tool_calls"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    tool_calls
        .iter()
        .enumerate()
        .filter_map(|(index, tool_call)| {
            let function = tool_call.get("function").unwrap_or(tool_call);
            let name = function.get("name").and_then(Value::as_str)?.trim();
            if name.is_empty() {
                return None;
            }
            let id = tool_call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("tool-call-{index}"));

            Some(json!({
                "id": id,
                "name": name,
                "arguments": parse_openai_tool_arguments(function.get("arguments"))
            }))
        })
        .collect()
}

fn append_openai_stream_tool_call_deltas(
    payload: &Value,
    tool_calls: &mut Vec<OpenAiStreamToolCallDelta>,
) {
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return;
    };
    for choice in choices {
        let raw_tool_calls = choice
            .get("delta")
            .and_then(|delta| delta.get("tool_calls"))
            .or_else(|| choice.get("tool_calls"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (fallback_index, raw_tool_call) in raw_tool_calls.iter().enumerate() {
            let index = raw_tool_call
                .get("index")
                .and_then(Value::as_u64)
                .map(|value| value as usize)
                .unwrap_or(fallback_index);
            while tool_calls.len() <= index {
                tool_calls.push(OpenAiStreamToolCallDelta::default());
            }
            let target = &mut tool_calls[index];
            if let Some(id) = raw_tool_call
                .get("id")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                target.id = id.trim().to_string();
            }
            let function = raw_tool_call.get("function").unwrap_or(raw_tool_call);
            if let Some(name) = function
                .get("name")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
            {
                target.name.push_str(name);
            }
            if let Some(arguments) = function.get("arguments").and_then(Value::as_str) {
                target.arguments.push_str(arguments);
            }
        }
    }
}

fn read_openai_stream_tool_calls(tool_calls: &[OpenAiStreamToolCallDelta]) -> Vec<Value> {
    tool_calls
        .iter()
        .enumerate()
        .filter_map(|(index, tool_call)| {
            let name = tool_call.name.trim();
            if name.is_empty() {
                return None;
            }
            let id = if tool_call.id.trim().is_empty() {
                format!("tool-call-{index}")
            } else {
                tool_call.id.trim().to_string()
            };
            let arguments = if tool_call.arguments.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&tool_call.arguments).unwrap_or_else(|_| json!({}))
            };
            Some(json!({
                "id": id,
                "name": name,
                "arguments": arguments
            }))
        })
        .collect()
}

fn read_anthropic_chat_content(payload: &Value) -> Result<String, String> {
    let content = ai_content_text(payload.get("content"));
    if content.trim().is_empty() {
        return Err("SD-Agent 响应为空。".to_string());
    }
    Ok(content)
}

fn create_chat_payload(request: &AiChatRequest, stream: bool) -> Value {
    if request.api_format == "anthropic" {
        let system_message = request
            .messages
            .iter()
            .find(|message| message.role == "system")
            .map(|message| message.content.clone())
            .unwrap_or_default();
        let messages = request
            .messages
            .iter()
            .filter(|message| message.role != "system")
            .map(|message| {
                json!({
                    "role": if message.role == "assistant" { "assistant" } else { "user" },
                    "content": message.content
                })
            })
            .collect::<Vec<_>>();
        let mut payload = json!({
            "model": request.model,
            "max_tokens": 4096,
            "temperature": request.temperature,
            "messages": messages
        });
        if stream {
            payload["stream"] = json!(true);
        }
        if !system_message.is_empty() {
            payload["system"] = json!(system_message);
        }
        return payload;
    }
    let mut payload = json!({
        "model": request.model,
        "temperature": request.temperature,
        "messages": request
            .messages
            .iter()
            .map(|message| {
                if message.role == "tool" {
                    let mut output = json!({
                        "role": "tool",
                        "content": message.content,
                        "tool_call_id": message.tool_call_id.clone().unwrap_or_default()
                    });
                    if let Some(name) = &message.tool_name {
                        output["name"] = json!(name);
                    }
                    return output;
                }
                if message.role == "assistant" && !message.tool_calls.is_empty() {
                    return json!({
                        "role": "assistant",
                        "content": if message.content.trim().is_empty() { Value::Null } else { json!(message.content) },
                        "tool_calls": message.tool_calls
                    });
                }
                json!({ "role": message.role, "content": message.content })
            })
            .collect::<Vec<_>>()
    });
    if stream {
        payload["stream"] = json!(true);
    }
    if !request.tools.is_empty() {
        payload["tools"] = json!(request
            .tools
            .iter()
            .map(|tool| json!({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters
                }
            }))
            .collect::<Vec<_>>());
    }
    payload
}

fn ai_request_builder(
    client: &reqwest::Client,
    method: reqwest::Method,
    endpoint: &str,
    request: &AiModelListRequest,
    accept: &str,
) -> reqwest::RequestBuilder {
    let mut builder = client.request(method, endpoint).header("accept", accept);
    if request.api_format == "anthropic" {
        builder = builder.header("anthropic-version", ANTHROPIC_API_VERSION);
        if !request.api_key.is_empty() {
            builder = builder.header("x-api-key", &request.api_key);
        }
    } else if !request.api_key.is_empty() {
        builder = builder.header("authorization", format!("Bearer {}", request.api_key));
    }
    builder
}

fn default_web_search_api_base_url(provider: &str) -> String {
    match provider {
        "exa" => "https://api.exa.ai".to_string(),
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4".to_string(),
        _ => "https://api.tavily.com".to_string(),
    }
}

fn web_search_endpoint(request: &WebSearchRequest) -> String {
    let suffix = match request.provider.as_str() {
        "exa" => "/search",
        "zhipu" => "/web_search",
        _ => "/search",
    };
    if request.api_base_url.ends_with(suffix) {
        request.api_base_url.clone()
    } else {
        format!("{}{}", request.api_base_url.trim_end_matches('/'), suffix)
    }
}

fn create_web_search_payload(request: &WebSearchRequest) -> Value {
    match request.provider.as_str() {
        "exa" => json!({
            "query": request.query,
            "type": "auto",
            "numResults": request.max_results,
            "contents": {
                "text": {
                    "maxCharacters": MAX_WEB_SEARCH_SNIPPET_LENGTH
                }
            }
        }),
        "zhipu" => json!({
            "search_engine": "search_std",
            "search_query": request.query,
            "count": request.max_results,
            "search_intent": false,
            "search_recency_filter": "noLimit"
        }),
        _ => json!({
            "query": request.query,
            "search_depth": "basic",
            "max_results": request.max_results,
            "include_answer": false,
            "include_raw_content": false
        }),
    }
}

fn web_search_request_builder(
    client: &reqwest::Client,
    request: &WebSearchRequest,
    endpoint: &str,
) -> reqwest::RequestBuilder {
    let builder = client
        .post(endpoint)
        .header("accept", "application/json")
        .header("content-type", "application/json");
    if request.provider == "exa" {
        builder.header("x-api-key", &request.api_key)
    } else {
        builder.header("authorization", format!("Bearer {}", request.api_key))
    }
}

fn web_search_result_text(item: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| item.get(*key).and_then(Value::as_str))
        .unwrap_or("")
        .trim()
        .to_string()
}

fn truncate_web_search_text(value: String, max_len: usize) -> String {
    if value.chars().count() <= max_len {
        return value;
    }
    value.chars().take(max_len).collect::<String>()
}

fn read_web_search_results(provider: &str, payload: &Value, max_results: usize) -> Vec<Value> {
    let raw_results = payload
        .get("results")
        .or_else(|| payload.get("search_result"))
        .or_else(|| payload.get("searchResults"))
        .or_else(|| payload.get("data").and_then(|data| data.get("results")))
        .or_else(|| {
            payload
                .get("data")
                .and_then(|data| data.get("search_result"))
        })
        .or_else(|| {
            payload
                .get("data")
                .and_then(|data| data.get("searchResults"))
        })
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    raw_results
        .iter()
        .take(max_results)
        .enumerate()
        .filter_map(|(index, item)| {
            let title = web_search_result_text(item, &["title", "name"]);
            let url = web_search_result_text(item, &["url", "link"]);
            if title.is_empty() || url.is_empty() {
                return None;
            }
            let snippet = truncate_web_search_text(
                web_search_result_text(
                    item,
                    &[
                        "snippet",
                        "content",
                        "text",
                        "summary",
                        "description",
                        "raw_content",
                    ],
                ),
                MAX_WEB_SEARCH_SNIPPET_LENGTH,
            );
            let published_at = web_search_result_text(
                item,
                &[
                    "publishedAt",
                    "published_at",
                    "publishedDate",
                    "publish_date",
                    "date",
                ],
            );
            let mut output = json!({
                "title": truncate_web_search_text(title, 500),
                "url": truncate_web_search_text(url, 2048),
                "snippet": snippet,
                "source": provider,
                "rank": index + 1
            });
            if !published_at.is_empty() {
                output["publishedAt"] = json!(truncate_web_search_text(published_at, 120));
            }
            Some(output)
        })
        .collect()
}

async fn request_web_search(raw_request: Value) -> Result<Value, String> {
    let request = read_web_search_request(raw_request)?;
    let endpoint = web_search_endpoint(&request);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(WEB_SEARCH_TIMEOUT_SECS))
        .build()
        .map_err(error_string)?;
    let response = web_search_request_builder(&client, &request, &endpoint)
        .json(&create_web_search_payload(&request))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "网络搜索请求超时。".to_string()
            } else {
                error_string(error)
            }
        })?;
    let status = response.status();
    let response_text = response.text().await.map_err(error_string)?;
    let payload = parse_json_response(&response_text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(read_error_message(Some(&payload), &response_text));
    }
    let results = read_web_search_results(&request.provider, &payload, request.max_results);
    Ok(json!({
        "endpoint": endpoint,
        "query": request.query,
        "provider": request.provider,
        "results": results
    }))
}

async fn list_ai_models(raw_request: Value) -> Result<Value, String> {
    let request = read_ai_model_list_request(raw_request)?;
    let endpoint = create_models_endpoint(&request.api_format, &request.api_base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(MODEL_LIST_TIMEOUT_SECS))
        .build()
        .map_err(error_string)?;
    let response = ai_request_builder(
        &client,
        reqwest::Method::GET,
        &endpoint,
        &request,
        "application/json",
    )
    .send()
    .await
    .map_err(|error| {
        if error.is_timeout() {
            "获取模型列表超时。".to_string()
        } else {
            error_string(error)
        }
    })?;
    let status = response.status();
    let response_text = response.text().await.map_err(error_string)?;
    let payload = parse_json_response(&response_text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(read_error_message(Some(&payload), &response_text));
    }
    let models = parse_model_list(&payload);
    if models.is_empty() {
        return Err("未从提供商返回可用模型。".to_string());
    }
    Ok(json!({ "endpoint": endpoint, "models": models }))
}

async fn request_ai_chat(raw_request: Value) -> Result<Value, String> {
    let request = read_ai_chat_request(raw_request)?;
    let endpoint = create_chat_endpoint(&request.api_format, &request.api_base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHAT_TIMEOUT_SECS))
        .build()
        .map_err(error_string)?;
    let base_request = AiModelListRequest {
        api_format: request.api_format.clone(),
        api_base_url: request.api_base_url.clone(),
        api_key: request.api_key.clone(),
    };
    let response = ai_request_builder(
        &client,
        reqwest::Method::POST,
        &endpoint,
        &base_request,
        "application/json",
    )
    .header("content-type", "application/json")
    .json(&create_chat_payload(&request, false))
    .send()
    .await
    .map_err(|error| {
        if error.is_timeout() {
            "SD-Agent 请求超时。".to_string()
        } else {
            error_string(error)
        }
    })?;
    let status = response.status();
    let response_text = response.text().await.map_err(error_string)?;
    let payload = parse_json_response(&response_text).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(read_error_message(Some(&payload), &response_text));
    }
    let (content, tool_calls) = if request.api_format == "anthropic" {
        (read_anthropic_chat_content(&payload)?, Vec::new())
    } else {
        let tool_calls = read_openai_tool_calls(&payload);
        let content = read_openai_chat_content_optional(&payload);
        if content.trim().is_empty() && tool_calls.is_empty() {
            return Err("SD-Agent 响应为空。".to_string());
        }
        (content, tool_calls)
    };
    Ok(json!({ "endpoint": endpoint, "content": content, "toolCalls": tool_calls }))
}

fn extract_openai_stream_delta(payload: &Value) -> Result<String, String> {
    if payload.get("error").is_some() {
        return Err(read_error_message(Some(payload), ""));
    }
    let Some(choices) = payload.get("choices").and_then(Value::as_array) else {
        return Ok(String::new());
    };
    Ok(choices
        .iter()
        .map(|choice| {
            ai_content_text(
                choice
                    .get("delta")
                    .and_then(|delta| delta.get("content"))
                    .or_else(|| {
                        choice
                            .get("message")
                            .and_then(|message| message.get("content"))
                    })
                    .or_else(|| choice.get("text")),
            )
        })
        .collect::<Vec<_>>()
        .join(""))
}

fn extract_anthropic_stream_delta(payload: &Value) -> Result<String, String> {
    if payload.get("type").and_then(Value::as_str) == Some("error") {
        return Err(read_error_message(Some(payload), ""));
    }
    if payload.get("type").and_then(Value::as_str) == Some("content_block_delta") {
        if let Some(text) = payload
            .get("delta")
            .and_then(|delta| delta.get("text"))
            .and_then(Value::as_str)
        {
            return Ok(text.to_string());
        }
    }
    if payload.get("type").and_then(Value::as_str) == Some("content_block_start") {
        if let Some(text) = payload
            .get("content_block")
            .and_then(|block| block.get("text"))
            .and_then(Value::as_str)
        {
            return Ok(text.to_string());
        }
    }
    Ok(String::new())
}

fn find_sse_separator(buffer: &[u8]) -> Option<(usize, usize)> {
    let find = |needle: &[u8]| {
        buffer
            .windows(needle.len())
            .position(|window| window == needle)
    };
    let rn = find(b"\r\n\r\n").map(|index| (index, 4));
    let n = find(b"\n\n").map(|index| (index, 2));
    match (rn, n) {
        (Some(left), Some(right)) => Some(if left.0 <= right.0 { left } else { right }),
        (Some(value), None) | (None, Some(value)) => Some(value),
        (None, None) => None,
    }
}

#[derive(Default)]
struct SseUtf8Decoder {
    buffer: Vec<u8>,
}

impl SseUtf8Decoder {
    #[cfg(test)]
    fn push(&mut self, chunk: &[u8]) -> Result<Vec<String>, String> {
        let mut messages = Vec::new();
        self.push_until(chunk, |message| {
            messages.push(message);
            Ok(false)
        })?;
        Ok(messages)
    }

    fn push_until<F>(&mut self, chunk: &[u8], mut consume: F) -> Result<bool, String>
    where
        F: FnMut(String) -> Result<bool, String>,
    {
        self.buffer.extend_from_slice(chunk);
        while let Some((index, separator_len)) = find_sse_separator(&self.buffer) {
            if index > MAX_AI_SSE_MESSAGE_BYTES {
                return Err("SD-Agent 流式响应事件过大。".to_string());
            }
            let tail = self.buffer.split_off(index + separator_len);
            self.buffer.truncate(index);
            let message = Self::decode(std::mem::replace(&mut self.buffer, tail))?;
            if consume(message)? {
                self.buffer.clear();
                return Ok(true);
            }
        }
        if self.buffer.len() > MAX_AI_SSE_MESSAGE_BYTES {
            return Err("SD-Agent 流式响应事件过大。".to_string());
        }
        Ok(false)
    }

    fn finish(self) -> Result<Option<String>, String> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Ok(None);
        }
        Self::decode(self.buffer).map(Some)
    }

    fn decode(message: Vec<u8>) -> Result<String, String> {
        String::from_utf8(message).map_err(|_| "SD-Agent 流式响应包含无效 UTF-8。".to_string())
    }
}

fn parse_sse_message(raw_message: &str) -> Option<String> {
    let data_lines = raw_message
        .lines()
        .filter_map(|line| {
            let line = line.trim_end_matches('\r');
            if line.is_empty() || line.starts_with(':') {
                return None;
            }
            line.strip_prefix("data:")
                .map(|value| value.strip_prefix(' ').unwrap_or(value).to_string())
        })
        .collect::<Vec<_>>();
    if data_lines.is_empty() {
        None
    } else {
        Some(data_lines.join("\n"))
    }
}

async fn request_ai_chat_stream(
    window: &tauri::Window,
    raw_request: Value,
) -> Result<Value, String> {
    let request = read_ai_chat_stream_request(raw_request)?;
    let endpoint = create_chat_endpoint(&request.chat.api_format, &request.chat.api_base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(CHAT_STREAM_TIMEOUT_SECS))
        .build()
        .map_err(error_string)?;
    let base_request = AiModelListRequest {
        api_format: request.chat.api_format.clone(),
        api_base_url: request.chat.api_base_url.clone(),
        api_key: request.chat.api_key.clone(),
    };
    let response = ai_request_builder(
        &client,
        reqwest::Method::POST,
        &endpoint,
        &base_request,
        "text/event-stream",
    )
    .header("content-type", "application/json")
    .json(&create_chat_payload(&request.chat, true))
    .send()
    .await
    .map_err(|error| {
        if error.is_timeout() {
            "SD-Agent 流式请求超时。".to_string()
        } else {
            error_string(error)
        }
    })?;
    if !response.status().is_success() {
        let response_text = response.text().await.map_err(error_string)?;
        return Err(read_error_message(
            parse_json_response(&response_text).as_ref(),
            &response_text,
        ));
    }

    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let mut content = String::new();
    if !content_type.contains("text/event-stream") {
        let response_text = response.text().await.map_err(error_string)?;
        let payload = parse_json_response(&response_text).unwrap_or(Value::Null);
        let (chunk, tool_calls) = if request.chat.api_format == "anthropic" {
            (read_anthropic_chat_content(&payload)?, Vec::new())
        } else {
            let tool_calls = read_openai_tool_calls(&payload);
            let chunk = read_openai_chat_content_optional(&payload);
            if chunk.trim().is_empty() && tool_calls.is_empty() {
                return Err("SD-Agent 响应为空。".to_string());
            }
            (chunk, tool_calls)
        };
        content.push_str(&chunk);
        if !chunk.is_empty() {
            let _ = window.emit(
                "ai:chat-stream:chunk",
                json!({ "streamId": request.stream_id, "chunk": chunk }),
            );
        }
        return Ok(json!({ "endpoint": endpoint, "content": content, "toolCalls": tool_calls }));
    }

    let mut decoder = SseUtf8Decoder::default();
    let mut openai_tool_call_deltas: Vec<OpenAiStreamToolCallDelta> = Vec::new();
    let mut stream = response.bytes_stream();
    {
        let mut consume_message = |raw_message: &str| -> Result<bool, String> {
            let Some(data) = parse_sse_message(raw_message) else {
                return Ok(false);
            };
            if data == "[DONE]" {
                return Ok(true);
            }
            let Some(payload) = parse_json_response(&data) else {
                return Ok(false);
            };
            if request.chat.api_format != "anthropic" {
                append_openai_stream_tool_call_deltas(&payload, &mut openai_tool_call_deltas);
            }
            let content_chunk = if request.chat.api_format == "anthropic" {
                extract_anthropic_stream_delta(&payload)?
            } else {
                extract_openai_stream_delta(&payload)?
            };
            if content_chunk.is_empty() {
                return Ok(false);
            }
            content.push_str(&content_chunk);
            let _ = window.emit(
                "ai:chat-stream:chunk",
                json!({ "streamId": request.stream_id, "chunk": content_chunk }),
            );
            Ok(false)
        };

        let mut reached_done = false;
        'read_stream: while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(error_string)?;
            if decoder.push_until(&chunk, |raw_message| consume_message(&raw_message))? {
                reached_done = true;
                break 'read_stream;
            }
        }
        if !reached_done {
            if let Some(raw_message) = decoder.finish()? {
                consume_message(&raw_message)?;
            }
        }
    }
    let tool_calls = if request.chat.api_format == "anthropic" {
        Vec::new()
    } else {
        read_openai_stream_tool_calls(&openai_tool_call_deltas)
    };
    if content.trim().is_empty() && tool_calls.is_empty() {
        return Err("SD-Agent 响应为空。".to_string());
    }
    Ok(json!({ "endpoint": endpoint, "content": content, "toolCalls": tool_calls }))
}

trait StringFallback {
    fn if_empty(self, fallback: String) -> String;
}

impl StringFallback for String {
    fn if_empty(self, fallback: String) -> String {
        if self.is_empty() {
            fallback
        } else {
            self
        }
    }
}

#[cfg(test)]
#[path = "ai_tests.rs"]
mod tests;
