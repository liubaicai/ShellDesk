use super::*;

fn web_request(provider: &str, api_base_url: &str, max_results: usize) -> WebSearchRequest {
    WebSearchRequest {
        provider: provider.to_string(),
        api_base_url: api_base_url.to_string(),
        api_key: "test-key".to_string(),
        query: "rust sse".to_string(),
        max_results,
    }
}

fn chat_message(role: &str, content: &str) -> AiChatMessage {
    AiChatMessage {
        role: role.to_string(),
        content: content.to_string(),
        tool_call_id: None,
        tool_name: None,
        tool_calls: Vec::new(),
    }
}

fn valid_chat_request() -> Value {
    json!({
        "apiFormat": "openai",
        "apiBaseUrl": "https://api.example.com/v1",
        "apiKey": "",
        "model": "test-model",
        "messages": [{ "role": "user", "content": "hello" }]
    })
}

fn chat_request_error(raw_request: Value) -> String {
    match read_ai_chat_request(raw_request) {
        Ok(_) => panic!("expected chat request validation to fail"),
        Err(error) => error,
    }
}

fn chat_stream_request_error(raw_request: Value) -> String {
    match read_ai_chat_stream_request(raw_request) {
        Ok(_) => panic!("expected chat stream request validation to fail"),
        Err(error) => error,
    }
}

#[test]
fn version_path_detection_requires_a_numeric_version_component() {
    for (url, expected) in [
        ("https://api.example.com/v1", true),
        ("https://api.example.com/v12", true),
        ("https://api.example.com/v2/beta", true),
        ("https://api.example.com/api/v1", true),
        ("https://api.example.com/api/v1/beta", true),
        ("https://api.example.com/v", false),
        ("https://api.example.com/version1", false),
        ("https://api.example.com/api/version1", false),
        ("not-a-url", false),
    ] {
        assert_eq!(api_base_is_version_path(url), expected, "{url}");
    }
}

#[test]
fn api_base_url_normalization_trims_slashes_and_rejects_unsafe_suffixes() {
    assert_eq!(
        read_ai_api_base_url(Some(&json!(" https://api.example.com/v1/// "))).unwrap(),
        "https://api.example.com/v1"
    );
    assert_eq!(
        read_ai_api_base_url(Some(&json!("ftp://api.example.com"))).unwrap_err(),
        "AI API 地址只支持 http 或 https。"
    );
    assert_eq!(
        read_ai_api_base_url(Some(&json!("not a url"))).unwrap_err(),
        "AI API 地址无效。"
    );
    for api_base_url in [
        "https://api.example.com/v1?tenant=a",
        "https://api.example.com/v1#models",
        "https://api.example.com/v1?tenant=a#models",
    ] {
        assert_eq!(
            read_ai_api_base_url(Some(&json!(api_base_url))).unwrap_err(),
            "AI API 地址不能包含查询参数或片段。",
            "{api_base_url}"
        );
    }
}

#[test]
fn normalized_api_base_url_builds_paths_before_any_query_or_fragment() {
    let api_base_url =
        read_ai_api_base_url(Some(&json!("https://api.example.com/api/v1///"))).unwrap();
    assert_eq!(
        create_models_endpoint("openai", &api_base_url),
        "https://api.example.com/api/v1/models"
    );
    assert_eq!(
        create_chat_endpoint("openai", &api_base_url),
        "https://api.example.com/api/v1/chat/completions"
    );
}

#[test]
fn model_endpoints_follow_provider_and_existing_path_contracts() {
    for (format, base, expected) in [
        (
            "openai",
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/models",
        ),
        (
            "openai",
            "https://api.example.com/models",
            "https://api.example.com/models",
        ),
        (
            "anthropic",
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1/models",
        ),
        (
            "anthropic",
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/models",
        ),
        (
            "anthropic",
            "https://api.anthropic.com/v1/beta",
            "https://api.anthropic.com/v1/beta/models",
        ),
        (
            "anthropic",
            "https://api.example.com/api/v1",
            "https://api.example.com/api/v1/models",
        ),
    ] {
        assert_eq!(create_models_endpoint(format, base), expected);
    }
}

#[test]
fn chat_endpoints_follow_provider_and_existing_path_contracts() {
    for (format, base, expected) in [
        (
            "openai",
            "https://api.openai.com/v1",
            "https://api.openai.com/v1/chat/completions",
        ),
        (
            "openai",
            "https://api.example.com/chat/completions",
            "https://api.example.com/chat/completions",
        ),
        (
            "anthropic",
            "https://api.anthropic.com",
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "anthropic",
            "https://api.anthropic.com/v1",
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "anthropic",
            "https://api.anthropic.com/v1/messages",
            "https://api.anthropic.com/v1/messages",
        ),
        (
            "anthropic",
            "https://api.example.com/api/v1",
            "https://api.example.com/api/v1/messages",
        ),
    ] {
        assert_eq!(create_chat_endpoint(format, base), expected);
    }
}

#[test]
fn chat_request_rejects_missing_required_fields_and_anthropic_key() {
    let mut missing_url = valid_chat_request();
    missing_url.as_object_mut().unwrap().remove("apiBaseUrl");
    assert_eq!(chat_request_error(missing_url), "AI API 地址不能为空。");

    let mut missing_model = valid_chat_request();
    missing_model.as_object_mut().unwrap().remove("model");
    assert_eq!(chat_request_error(missing_model), "SD-Agent 模型不能为空。");

    let mut empty_messages = valid_chat_request();
    empty_messages["messages"] = json!([]);
    assert_eq!(
        chat_request_error(empty_messages),
        "SD-Agent 消息不能为空。"
    );

    let mut blank_message = valid_chat_request();
    blank_message["messages"] = json!([{ "role": "user", "content": "   " }]);
    assert_eq!(
        chat_request_error(blank_message),
        "SD-Agent 消息内容不能为空。"
    );

    let mut missing_anthropic_key = valid_chat_request();
    missing_anthropic_key["apiFormat"] = json!("anthropic");
    assert_eq!(
        chat_request_error(missing_anthropic_key),
        "请输入AI API 密钥。"
    );
}

#[test]
fn chat_request_keeps_only_the_latest_message_window() {
    let mut raw_request = valid_chat_request();
    raw_request["messages"] = Value::Array(
        (0..MAX_AI_MESSAGE_COUNT + 3)
            .map(|index| json!({ "role": "user", "content": format!("message-{index}") }))
            .collect(),
    );

    let request = read_ai_chat_request(raw_request).unwrap();
    assert_eq!(request.messages.len(), MAX_AI_MESSAGE_COUNT);
    assert_eq!(request.messages.first().unwrap().content, "message-3");
    assert_eq!(
        request.messages.last().unwrap().content,
        format!("message-{}", MAX_AI_MESSAGE_COUNT + 2)
    );
}

#[test]
fn chat_request_limits_tools_and_defaults_optional_tool_fields() {
    let tool_limit = 32;
    let mut tools = (0..tool_limit)
        .map(|index| {
            if index == 0 {
                json!({ "name": " tool-0 ", "parameters": [] })
            } else if index == 1 {
                json!({
                    "name": "tool-1",
                    "description": " described ",
                    "parameters": { "type": "string" }
                })
            } else {
                json!({ "name": format!("tool-{index}") })
            }
        })
        .collect::<Vec<_>>();
    tools.push(json!({ "name": "" }));
    tools.push(json!({ "name": "tool-after-limit" }));

    let mut raw_request = valid_chat_request();
    raw_request["tools"] = Value::Array(tools);
    let request = read_ai_chat_request(raw_request).unwrap();

    assert_eq!(request.tools.len(), tool_limit);
    assert_eq!(request.tools[0].name, "tool-0");
    assert_eq!(request.tools[0].description, "");
    assert_eq!(
        request.tools[0].parameters,
        json!({ "type": "object", "properties": {} })
    );
    assert_eq!(request.tools[1].description, "described");
    assert_eq!(request.tools[1].parameters, json!({ "type": "string" }));
    assert_eq!(request.tools.last().unwrap().name, "tool-31");
}

#[test]
fn chat_request_temperature_accepts_bounds_and_falls_back_for_invalid_values() {
    for (raw_temperature, expected) in [(json!(0.0), 0.0), (json!(1.25), 1.25), (json!(2.0), 2.0)] {
        let mut raw_request = valid_chat_request();
        raw_request["temperature"] = raw_temperature;
        assert_eq!(
            read_ai_chat_request(raw_request).unwrap().temperature,
            expected
        );
    }

    for raw_temperature in [json!(-0.01), json!(2.01), json!("hot"), Value::Null] {
        let mut raw_request = valid_chat_request();
        raw_request["temperature"] = raw_temperature;
        assert_eq!(read_ai_chat_request(raw_request).unwrap().temperature, 0.2);
    }
}

#[test]
fn chat_request_enforces_model_and_message_length_boundaries() {
    let mut maximum = valid_chat_request();
    maximum["model"] = json!("m".repeat(MAX_AI_MODEL_NAME_LENGTH));
    maximum["messages"] = json!([{ "role": "user", "content": "x".repeat(MAX_AI_MESSAGE_LENGTH) }]);
    let request = read_ai_chat_request(maximum).unwrap();
    assert_eq!(request.model.chars().count(), MAX_AI_MODEL_NAME_LENGTH);
    assert_eq!(
        request.messages[0].content.chars().count(),
        MAX_AI_MESSAGE_LENGTH
    );

    let mut model_too_long = valid_chat_request();
    model_too_long["model"] = json!("m".repeat(MAX_AI_MODEL_NAME_LENGTH + 1));
    assert_eq!(chat_request_error(model_too_long), "SD-Agent 模型过长。");

    let mut message_too_long = valid_chat_request();
    message_too_long["messages"] = json!([{
        "role": "user",
        "content": "x".repeat(MAX_AI_MESSAGE_LENGTH + 1)
    }]);
    assert_eq!(
        chat_request_error(message_too_long),
        "SD-Agent 消息内容过长。"
    );
}

#[test]
fn chat_stream_request_requires_and_bounds_stream_id() {
    let mut maximum = valid_chat_request();
    maximum["streamId"] = json!("s".repeat(MAX_AI_STREAM_ID_LENGTH));
    let request = read_ai_chat_stream_request(maximum).unwrap();
    assert_eq!(request.stream_id.chars().count(), MAX_AI_STREAM_ID_LENGTH);
    assert_eq!(request.chat.model, "test-model");

    let mut missing = valid_chat_request();
    missing.as_object_mut().unwrap().remove("streamId");
    assert_eq!(
        chat_stream_request_error(missing),
        "SD-Agent 流式请求 ID不能为空。"
    );

    let mut too_long = valid_chat_request();
    too_long["streamId"] = json!("s".repeat(MAX_AI_STREAM_ID_LENGTH + 1));
    assert_eq!(
        chat_stream_request_error(too_long),
        "SD-Agent 流式请求 ID过长。"
    );
}

#[test]
fn model_list_accepts_supported_envelopes() {
    let raw_models = json!([
        "alpha",
        { "id": "beta", "display_name": "Beta" },
        7
    ]);
    let payloads = [
        raw_models.clone(),
        json!({ "data": raw_models }),
        json!({ "models": ["alpha", "beta", 7] }),
        json!({ "items": ["alpha", "beta", 7] }),
        json!({ "model_ids": ["alpha", "beta", 7] }),
    ];

    for payload in payloads {
        let models = parse_model_list(&payload);
        assert_eq!(models.len(), 3, "{payload}");
        assert_eq!(models[0]["id"], "alpha");
        assert_eq!(models[1]["id"], "beta");
        assert_eq!(models[2]["id"], "7");
    }
}

#[test]
fn model_list_normalizes_metadata_filters_invalid_entries_and_deduplicates() {
    let models = parse_model_list(&json!({
        "data": [
            {
                "id": " alpha ",
                "display_name": " Alpha Display ",
                "owned_by": " team ",
                "created": 1700000000
            },
            { "name": "beta", "label": "Beta Display" },
            { "id": "alpha", "displayName": "Duplicate" },
            { "unknown": "ignored" },
            ""
        ]
    }));

    assert_eq!(models.len(), 2);
    assert_eq!(
        models[0],
        json!({
            "id": "alpha",
            "name": "Alpha Display",
            "ownedBy": "team",
            "createdAt": "2023-11-14T22:13:20+00:00"
        })
    );
    assert_eq!(models[1], json!({ "id": "beta", "name": "Beta Display" }));
}

#[test]
fn sse_separator_supports_lf_crlf_and_chooses_the_earliest_boundary() {
    for (buffer, expected) in [
        ("data: one\n\nrest", Some((9, 2))),
        ("data: one\r\n\r\nrest", Some((9, 4))),
        ("a\n\nb\r\n\r\nc", Some((1, 2))),
        ("incomplete", None),
    ] {
        assert_eq!(
            find_sse_separator(buffer.as_bytes()),
            expected,
            "{buffer:?}"
        );
    }
}

#[test]
fn sse_utf8_decoder_preserves_unicode_across_every_byte_boundary() {
    let source =
        "data: {\"choices\":[{\"delta\":{\"content\":\"你好，ShellDesk 🌍🙂\"}}]}\n\ndata: [DONE]\n\n";
    let expected = vec![
        "data: {\"choices\":[{\"delta\":{\"content\":\"你好，ShellDesk 🌍🙂\"}}]}".to_string(),
        "data: [DONE]".to_string(),
    ];

    for split in 0..=source.len() {
        let mut decoder = SseUtf8Decoder::default();
        let mut messages = decoder.push(&source.as_bytes()[..split]).unwrap();
        messages.extend(decoder.push(&source.as_bytes()[split..]).unwrap());
        assert_eq!(decoder.finish().unwrap(), None, "split at byte {split}");
        assert_eq!(messages, expected, "split at byte {split}");
    }

    let mut decoder = SseUtf8Decoder::default();
    let mut messages = Vec::new();
    for byte in source.as_bytes() {
        messages.extend(decoder.push(std::slice::from_ref(byte)).unwrap());
    }
    assert_eq!(decoder.finish().unwrap(), None);
    assert_eq!(messages, expected);

    let data = parse_sse_message(&messages[0]).unwrap();
    let payload = parse_json_response(&data).unwrap();
    assert_eq!(
        extract_openai_stream_delta(&payload).unwrap(),
        "你好，ShellDesk 🌍🙂"
    );
}

#[test]
fn sse_utf8_decoder_handles_crlf_boundaries_and_rejects_invalid_utf8() {
    let source = "data: 中文😀\r\n\r\ndata: 再见👋";
    let mut decoder = SseUtf8Decoder::default();
    let mut messages = Vec::new();
    for byte in source.as_bytes() {
        messages.extend(decoder.push(std::slice::from_ref(byte)).unwrap());
    }
    messages.extend(decoder.finish().unwrap());
    assert_eq!(
        messages,
        vec!["data: 中文😀".to_string(), "data: 再见👋".to_string()]
    );

    let mut invalid = SseUtf8Decoder::default();
    assert_eq!(
        invalid.push(b"data: \xff\n\n").unwrap_err(),
        "SD-Agent 流式响应包含无效 UTF-8。"
    );
}

#[test]
fn sse_utf8_decoder_rejects_oversized_framed_and_unframed_events() {
    let oversized = vec![b'a'; MAX_AI_SSE_MESSAGE_BYTES + 1];

    let mut unframed = SseUtf8Decoder::default();
    assert_eq!(
        unframed.push(&oversized).unwrap_err(),
        "SD-Agent 流式响应事件过大。"
    );

    let mut framed_bytes = oversized;
    framed_bytes.extend_from_slice(b"\n\n");
    let mut framed = SseUtf8Decoder::default();
    assert_eq!(
        framed.push(&framed_bytes).unwrap_err(),
        "SD-Agent 流式响应事件过大。"
    );
}

#[test]
fn sse_utf8_decoder_stops_before_invalid_or_oversized_tail_after_done() {
    let mut invalid_tail = b"data: first\n\ndata: [DONE]\n\ndata: \xff\n\n".to_vec();
    let mut seen = Vec::new();
    let mut decoder = SseUtf8Decoder::default();
    let stopped = decoder
        .push_until(&invalid_tail, |message| {
            let done = parse_sse_message(&message).as_deref() == Some("[DONE]");
            seen.push(message);
            Ok(done)
        })
        .unwrap();
    assert!(stopped);
    assert_eq!(
        seen,
        vec!["data: first".to_string(), "data: [DONE]".to_string()]
    );
    assert_eq!(decoder.finish().unwrap(), None);

    invalid_tail.clear();
    invalid_tail.extend_from_slice(b"data: [DONE]\n\n");
    invalid_tail.extend(std::iter::repeat_n(b'a', MAX_AI_SSE_MESSAGE_BYTES + 1));
    let mut decoder = SseUtf8Decoder::default();
    assert!(decoder
        .push_until(&invalid_tail, |message| {
            Ok(parse_sse_message(&message).as_deref() == Some("[DONE]"))
        })
        .unwrap());
    assert_eq!(decoder.finish().unwrap(), None);
}

#[test]
fn sse_message_combines_data_lines_and_ignores_comments_and_other_fields() {
    assert_eq!(
        parse_sse_message("event: message\r\ndata: first\r\n: keepalive\r\ndata:second\r\nid: 7"),
        Some("first\nsecond".to_string())
    );
    assert_eq!(parse_sse_message(": heartbeat\nevent: ping"), None);
    assert_eq!(parse_sse_message("data:"), Some(String::new()));
    assert_eq!(
        parse_sse_message("event: complete\ndata: [DONE]"),
        Some("[DONE]".to_string())
    );
}

#[test]
fn openai_stream_delta_supports_single_choice_content_shapes() {
    for (payload, expected) in [
        (json!({ "choices": [{ "delta": { "content": "A" } }] }), "A"),
        (
            json!({
                "choices": [{
                    "message": {
                        "content": [{ "text": "B" }, { "input_text": "C" }]
                    }
                }]
            }),
            "BC",
        ),
        (json!({ "choices": [{ "text": "D" }] }), "D"),
    ] {
        assert_eq!(extract_openai_stream_delta(&payload).unwrap(), expected);
    }
}

#[test]
fn stream_delta_errors_are_extracted_without_network_requests() {
    assert_eq!(
        extract_openai_stream_delta(
            &json!({ "error": { "error": { "message": " nested failure " } } })
        )
        .unwrap_err(),
        "nested failure"
    );
    assert_eq!(
        extract_anthropic_stream_delta(
            &json!({ "type": "error", "error": { "message": " overloaded " } })
        )
        .unwrap_err(),
        "overloaded"
    );
}

#[test]
fn anthropic_stream_delta_handles_start_delta_and_non_content_events() {
    for (payload, expected) in [
        (
            json!({ "type": "content_block_start", "content_block": { "text": "Hello" } }),
            "Hello",
        ),
        (
            json!({ "type": "content_block_delta", "delta": { "text": " world" } }),
            " world",
        ),
        (json!({ "type": "message_stop" }), ""),
    ] {
        assert_eq!(extract_anthropic_stream_delta(&payload).unwrap(), expected);
    }
}

#[test]
fn openai_tool_call_chunks_are_aggregated_by_index() {
    let mut deltas = Vec::new();
    append_openai_stream_tool_call_deltas(
        &json!({
            "choices": [{
                "delta": {
                    "tool_calls": [
                        {
                            "index": 0,
                            "id": " call-a ",
                            "function": { "name": "look", "arguments": "{\"q\":" }
                        },
                        {
                            "index": 1,
                            "id": "call-b",
                            "function": { "name": "calc", "arguments": "{\"x\":" }
                        }
                    ]
                }
            }]
        }),
        &mut deltas,
    );
    append_openai_stream_tool_call_deltas(
        &json!({
            "choices": [{
                "delta": {
                    "tool_calls": [
                        { "index": 1, "function": { "arguments": "2}" } },
                        {
                            "index": 0,
                            "function": { "name": "up", "arguments": "\"rust\"}" }
                        }
                    ]
                }
            }]
        }),
        &mut deltas,
    );

    assert_eq!(
        read_openai_stream_tool_calls(&deltas),
        vec![
            json!({ "id": "call-a", "name": "lookup", "arguments": { "q": "rust" } }),
            json!({ "id": "call-b", "name": "calc", "arguments": { "x": 2 } })
        ]
    );
}

#[test]
fn openai_stream_tool_calls_filter_unnamed_entries_and_sanitize_bad_arguments() {
    let deltas = vec![
        OpenAiStreamToolCallDelta::default(),
        OpenAiStreamToolCallDelta {
            id: " ".to_string(),
            name: " run ".to_string(),
            arguments: "not-json".to_string(),
        },
    ];

    assert_eq!(
        read_openai_stream_tool_calls(&deltas),
        vec![json!({
            "id": "tool-call-1",
            "name": "run",
            "arguments": {}
        })]
    );
}

#[test]
fn non_stream_openai_tool_calls_support_nested_and_flat_provider_shapes() {
    let payloads = [
        json!({
            "choices": [{
                "message": {
                    "tool_calls": [{
                        "id": "call-1",
                        "function": {
                            "name": "lookup",
                            "arguments": "{\"q\":\"rust\"}"
                        }
                    }]
                }
            }]
        }),
        json!({
            "choices": [{
                "tool_calls": [{
                    "name": "ping",
                    "arguments": { "count": 2 }
                }]
            }]
        }),
    ];

    assert_eq!(
        read_openai_tool_calls(&payloads[0]),
        vec![json!({
            "id": "call-1",
            "name": "lookup",
            "arguments": { "q": "rust" }
        })]
    );
    assert_eq!(
        read_openai_tool_calls(&payloads[1]),
        vec![json!({
            "id": "tool-call-0",
            "name": "ping",
            "arguments": { "count": 2 }
        })]
    );
}

#[test]
fn web_search_results_support_envelopes_and_filter_incomplete_items() {
    let raw_results = json!([
        {
            "name": " Rust release ",
            "link": " https://example.com/release ",
            "content": " stable ",
            "publish_date": " 2026-07-26 "
        },
        { "title": "missing URL" },
        { "url": "https://example.com/missing-title" }
    ]);
    let payloads = [
        json!({ "results": raw_results }),
        json!({ "search_result": [{
            "title": "Rust release",
            "url": "https://example.com/release"
        }] }),
        json!({ "data": { "searchResults": [{
            "title": "Rust release",
            "url": "https://example.com/release"
        }] } }),
    ];

    for payload in &payloads {
        let results = read_web_search_results("exa", payload, 10);
        assert_eq!(results.len(), 1, "{payload}");
        assert_eq!(results[0]["title"], "Rust release");
        assert_eq!(results[0]["url"], "https://example.com/release");
        assert_eq!(results[0]["source"], "exa");
        assert_eq!(results[0]["rank"], 1);
    }
    let detailed = read_web_search_results("exa", &payloads[0], 10);
    assert_eq!(detailed[0]["snippet"], "stable");
    assert_eq!(detailed[0]["publishedAt"], "2026-07-26");
}

#[test]
fn web_search_result_text_limits_are_unicode_safe() {
    let results = read_web_search_results(
        "tavily",
        &json!({
            "results": [{
                "title": "题".repeat(501),
                "url": "u".repeat(2049),
                "snippet": "你".repeat(MAX_WEB_SEARCH_SNIPPET_LENGTH + 1),
                "publishedAt": "日".repeat(121)
            }]
        }),
        1,
    );

    assert_eq!(results.len(), 1);
    assert_eq!(results[0]["title"].as_str().unwrap().chars().count(), 500);
    assert_eq!(results[0]["url"].as_str().unwrap().chars().count(), 2048);
    assert_eq!(
        results[0]["snippet"].as_str().unwrap().chars().count(),
        MAX_WEB_SEARCH_SNIPPET_LENGTH
    );
    assert_eq!(
        results[0]["publishedAt"].as_str().unwrap().chars().count(),
        120
    );
}

#[test]
fn web_search_request_defaults_and_bounds_are_normalized() {
    let default_request = read_web_search_request(json!({
        "provider": "unknown",
        "apiKey": " key ",
        "query": " rust ",
        "maxResults": 99
    }))
    .unwrap();
    assert_eq!(default_request.provider, "tavily");
    assert_eq!(default_request.api_base_url, "https://api.tavily.com");
    assert_eq!(default_request.api_key, "key");
    assert_eq!(default_request.query, "rust");
    assert_eq!(default_request.max_results, 5);

    let exa_request = read_web_search_request(json!({
        "provider": "exa",
        "apiBaseUrl": "https://search.example.com///",
        "apiKey": "key",
        "query": "rust",
        "maxResults": 20
    }))
    .unwrap();
    assert_eq!(exa_request.api_base_url, "https://search.example.com");
    assert_eq!(exa_request.max_results, 20);
}

#[test]
fn web_search_endpoints_do_not_duplicate_provider_suffixes() {
    for (provider, base, expected) in [
        (
            "tavily",
            "https://api.tavily.com",
            "https://api.tavily.com/search",
        ),
        (
            "exa",
            "https://api.exa.ai/search",
            "https://api.exa.ai/search",
        ),
        (
            "zhipu",
            "https://open.bigmodel.cn/api/paas/v4",
            "https://open.bigmodel.cn/api/paas/v4/web_search",
        ),
    ] {
        assert_eq!(
            web_search_endpoint(&web_request(provider, base, 5)),
            expected
        );
    }
}

#[test]
fn web_search_payloads_match_each_provider_contract() {
    let tavily = create_web_search_payload(&web_request("tavily", "https://api.tavily.com", 3));
    assert_eq!(tavily["max_results"], 3);
    assert_eq!(tavily["search_depth"], "basic");

    let exa = create_web_search_payload(&web_request("exa", "https://api.exa.ai", 4));
    assert_eq!(exa["numResults"], 4);
    assert_eq!(
        exa["contents"]["text"]["maxCharacters"],
        MAX_WEB_SEARCH_SNIPPET_LENGTH
    );

    let zhipu = create_web_search_payload(&web_request(
        "zhipu",
        "https://open.bigmodel.cn/api/paas/v4",
        5,
    ));
    assert_eq!(zhipu["count"], 5);
    assert_eq!(zhipu["search_engine"], "search_std");
}

#[test]
fn openai_chat_payload_preserves_tools_and_tool_result_messages() {
    let mut assistant = chat_message("assistant", "");
    assistant.tool_calls = vec![json!({
        "id": "call-1",
        "type": "function",
        "function": {
            "name": "lookup",
            "arguments": "{\"q\":\"rust\"}"
        }
    })];
    let mut tool_result = chat_message("tool", "result");
    tool_result.tool_call_id = Some("call-1".to_string());
    tool_result.tool_name = Some("lookup".to_string());
    let request = AiChatRequest {
        api_format: "openai".to_string(),
        api_base_url: "https://api.example.com/v1".to_string(),
        api_key: String::new(),
        model: "model".to_string(),
        messages: vec![assistant, tool_result],
        tools: vec![AiChatTool {
            name: "lookup".to_string(),
            description: "Search".to_string(),
            parameters: json!({ "type": "object" }),
        }],
        temperature: 0.2,
    };

    let payload = create_chat_payload(&request, true);
    assert_eq!(payload["stream"], true);
    assert_eq!(payload["messages"][0]["content"], Value::Null);
    assert_eq!(
        payload["messages"][0]["tool_calls"][0]["function"]["name"],
        "lookup"
    );
    assert_eq!(payload["messages"][1]["tool_call_id"], "call-1");
    assert_eq!(payload["messages"][1]["name"], "lookup");
    assert_eq!(payload["tools"][0]["function"]["name"], "lookup");
}

#[test]
fn anthropic_chat_payload_extracts_system_and_preserves_user_assistant_roles() {
    let request = AiChatRequest {
        api_format: "anthropic".to_string(),
        api_base_url: "https://api.anthropic.com".to_string(),
        api_key: "key".to_string(),
        model: "claude".to_string(),
        messages: vec![
            chat_message("system", "Be concise"),
            chat_message("user", "Question"),
            chat_message("assistant", "Answer"),
        ],
        tools: Vec::new(),
        temperature: 0.3,
    };

    let payload = create_chat_payload(&request, false);
    assert_eq!(payload["system"], "Be concise");
    assert_eq!(payload["messages"].as_array().unwrap().len(), 2);
    assert_eq!(payload["messages"][0]["role"], "user");
    assert_eq!(payload["messages"][0]["content"], "Question");
    assert_eq!(payload["messages"][1]["role"], "assistant");
    assert_eq!(payload["messages"][1]["content"], "Answer");
    assert!(payload.get("stream").is_none());
}

#[test]
fn error_message_prefers_structured_payloads_and_truncates_fallbacks() {
    for (payload, expected) in [
        (
            json!({ "error": { "message": " direct " } }),
            "direct".to_string(),
        ),
        (
            json!({ "error": { "error": { "message": " nested " } } }),
            "nested".to_string(),
        ),
        (json!({ "message": " top-level " }), "top-level".to_string()),
    ] {
        assert_eq!(read_error_message(Some(&payload), "fallback"), expected);
    }

    let fallback = "错".repeat(501);
    let message = read_error_message(None, &fallback);
    assert_eq!(message.chars().count(), 500);
    assert_eq!(read_error_message(None, "  "), "模型列表请求失败。");
}
