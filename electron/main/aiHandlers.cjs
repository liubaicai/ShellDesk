const {
  aiApiFormatChoices,
  maxAiApiBaseUrlLength,
  maxAiApiKeyLength,
} = require('./constants.cjs');
const { isPlainObject, readBoundedString } = require('./validation.cjs');

const anthropicApiVersion = '2023-06-01';
const modelListTimeoutMs = 20000;
const chatTimeoutMs = 60000;
const chatStreamTimeoutMs = 120000;
const maxAiModelNameLength = 200;
const maxAiMessageCount = 40;
const maxAiMessageLength = 120000;
const maxAiStreamIdLength = 80;

function readAiApiBaseUrl(value) {
  const apiBaseUrl = readBoundedString(value, 'AI API 地址', maxAiApiBaseUrlLength).replace(/\/+$/u, '');

  let parsedUrl;

  try {
    parsedUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error('AI API 地址无效。');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('AI API 地址只支持 http 或 https。');
  }

  return apiBaseUrl;
}

function readAiModelListRequest(rawRequest) {
  if (!isPlainObject(rawRequest)) {
    throw new Error('AI 模型列表请求无效。');
  }

  const provider = rawRequest.provider === 'anthropic' ? 'anthropic' : rawRequest.provider;
  const fallbackFormat = provider === 'anthropic' ? 'anthropic' : 'openai';
  const apiFormat = aiApiFormatChoices.includes(rawRequest.apiFormat) ? rawRequest.apiFormat : fallbackFormat;
  const apiBaseUrl = readAiApiBaseUrl(rawRequest.apiBaseUrl);
  const apiKey = readBoundedString(rawRequest.apiKey, 'AI API 密钥', maxAiApiKeyLength, {
    trim: true,
  });

  return {
    apiFormat,
    apiBaseUrl,
    apiKey,
  };
}

function readAiChatMessage(rawMessage) {
  if (!isPlainObject(rawMessage)) {
    throw new Error('SD-Agent 消息无效。');
  }

  const role = rawMessage.role === 'assistant' || rawMessage.role === 'system' ? rawMessage.role : 'user';
  const content = readBoundedString(rawMessage.content, 'SD-Agent 消息内容', maxAiMessageLength, {
    trim: false,
    rejectLineBreaks: false,
  });

  return { role, content };
}

function readAiChatRequest(rawRequest) {
  const baseRequest = readAiModelListRequest(rawRequest);
  const model = readBoundedString(rawRequest.model, 'SD-Agent 模型', maxAiModelNameLength);
  const messages = Array.isArray(rawRequest.messages)
    ? rawRequest.messages.slice(-maxAiMessageCount).map((message) => readAiChatMessage(message))
    : [];
  const temperature = Number(rawRequest.temperature);

  if (!messages.length) {
    throw new Error('SD-Agent 消息不能为空。');
  }

  return {
    ...baseRequest,
    model,
    messages,
    temperature: Number.isFinite(temperature) && temperature >= 0 && temperature <= 2 ? temperature : 0.2,
  };
}

function readAiChatStreamRequest(rawRequest) {
  const request = readAiChatRequest(rawRequest);
  const streamId = readBoundedString(rawRequest.streamId, 'SD-Agent 流式请求 ID', maxAiStreamIdLength);

  return {
    ...request,
    streamId,
  };
}

function appendPath(apiBaseUrl, pathSuffix) {
  return `${apiBaseUrl.replace(/\/+$/u, '')}${pathSuffix}`;
}

function createModelsEndpoint(apiFormat, apiBaseUrl) {
  if (/\/models\/?$/iu.test(apiBaseUrl)) {
    return apiBaseUrl;
  }

  if (apiFormat === 'anthropic') {
    if (/\/v\d+(?:\/beta)?$/iu.test(apiBaseUrl)) {
      return appendPath(apiBaseUrl, '/models');
    }

    return appendPath(apiBaseUrl, '/v1/models');
  }

  return appendPath(apiBaseUrl, '/models');
}

function createChatEndpoint(apiFormat, apiBaseUrl) {
  if (apiFormat === 'anthropic') {
    if (/\/messages\/?$/iu.test(apiBaseUrl)) {
      return apiBaseUrl;
    }

    if (/\/v\d+(?:\/beta)?$/iu.test(apiBaseUrl)) {
      return appendPath(apiBaseUrl, '/messages');
    }

    return appendPath(apiBaseUrl, '/v1/messages');
  }

  if (/\/chat\/completions\/?$/iu.test(apiBaseUrl)) {
    return apiBaseUrl;
  }

  return appendPath(apiBaseUrl, '/chat/completions');
}

function parseJsonResponse(text) {
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function readErrorMessage(payload, fallbackText) {
  if (isPlainObject(payload?.error)) {
    const message = payload.error.message || payload.error.error?.message || payload.error.type;

    if (typeof message === 'string' && message.trim()) {
      return message.trim();
    }
  }

  if (typeof payload?.message === 'string' && payload.message.trim()) {
    return payload.message.trim();
  }

  if (fallbackText.trim()) {
    return fallbackText.trim().slice(0, 500);
  }

  return '模型列表请求失败。';
}

function toIsoTime(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value * 1000).toISOString();
  }

  return undefined;
}

function normalizeModelEntry(rawModel) {
  if (typeof rawModel === 'string') {
    const modelId = rawModel.trim();
    return modelId ? { id: modelId, name: modelId } : null;
  }

  if (!isPlainObject(rawModel)) {
    return null;
  }

  const modelId = typeof rawModel.id === 'string' ? rawModel.id.trim() : '';

  if (!modelId) {
    return null;
  }

  const modelName = typeof rawModel.display_name === 'string' && rawModel.display_name.trim()
    ? rawModel.display_name.trim()
    : typeof rawModel.name === 'string' && rawModel.name.trim()
      ? rawModel.name.trim()
      : modelId;
  const ownedBy = typeof rawModel.owned_by === 'string' && rawModel.owned_by.trim()
    ? rawModel.owned_by.trim()
    : typeof rawModel.type === 'string' && rawModel.type.trim()
      ? rawModel.type.trim()
      : undefined;

  return {
    id: modelId,
    name: modelName,
    createdAt: toIsoTime(rawModel.created_at ?? rawModel.created),
    ownedBy,
  };
}

function parseModelList(payload) {
  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const seenModelIds = new Set();
  const models = [];

  for (const rawModel of rawModels.slice(0, 1000)) {
    const model = normalizeModelEntry(rawModel);

    if (!model || seenModelIds.has(model.id)) {
      continue;
    }

    seenModelIds.add(model.id);
    models.push(model);
  }

  return models;
}

function readOpenAiChatContent(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === 'string' && content.trim()) {
    return content;
  }

  throw new Error('SD-Agent 响应为空。');
}

function readAnthropicChatContent(payload) {
  if (!Array.isArray(payload?.content)) {
    throw new Error('SD-Agent 响应为空。');
  }

  const content = payload.content
    .map((item) => isPlainObject(item) && item.type === 'text' && typeof item.text === 'string' ? item.text : '')
    .join('')
    .trim();

  if (content) {
    return content;
  }

  throw new Error('SD-Agent 响应为空。');
}

function createChatPayload(request, stream = false) {
  if (request.apiFormat === 'anthropic') {
    const systemMessage = request.messages.find((message) => message.role === 'system')?.content ?? '';

    return {
      model: request.model,
      max_tokens: 4096,
      temperature: request.temperature,
      ...(stream ? { stream: true } : {}),
      ...(systemMessage ? { system: systemMessage } : {}),
      messages: request.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role === 'assistant' ? 'assistant' : 'user',
          content: message.content,
        })),
    };
  }

  return {
    model: request.model,
    temperature: request.temperature,
    messages: request.messages,
    ...(stream ? { stream: true } : {}),
  };
}

function createChatHeaders(request) {
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };

  if (request.apiFormat === 'anthropic') {
    headers['x-api-key'] = request.apiKey;
    headers['anthropic-version'] = anthropicApiVersion;
  } else {
    headers.authorization = `Bearer ${request.apiKey}`;
  }

  return headers;
}

function extractOpenAiStreamDelta(payload) {
  if (isPlainObject(payload?.error)) {
    throw new Error(readErrorMessage(payload, ''));
  }

  if (!Array.isArray(payload?.choices)) {
    return '';
  }

  return payload.choices
    .map((choice) => {
      const content = choice?.delta?.content ?? choice?.message?.content ?? '';
      return typeof content === 'string' ? content : '';
    })
    .join('');
}

function extractAnthropicStreamDelta(payload) {
  if (payload?.type === 'error') {
    throw new Error(readErrorMessage(payload, ''));
  }

  const deltaText = payload?.delta?.text;
  if (payload?.type === 'content_block_delta' && typeof deltaText === 'string') {
    return deltaText;
  }

  const blockText = payload?.content_block?.text;
  if (payload?.type === 'content_block_start' && typeof blockText === 'string') {
    return blockText;
  }

  return '';
}

function parseSseMessage(rawMessage) {
  const lines = rawMessage.split(/\r?\n/u);
  let eventName = 'message';
  const dataLines = [];

  for (const line of lines) {
    if (!line || line.startsWith(':')) {
      continue;
    }

    if (line.startsWith('event:')) {
      eventName = line.slice(6).trim() || eventName;
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /u, ''));
    }
  }

  if (!dataLines.length) {
    return null;
  }

  return {
    eventName,
    data: dataLines.join('\n'),
  };
}

async function readEventStream(response, onEvent) {
  const reader = response.body?.getReader?.();

  if (!reader) {
    throw new Error('SD-Agent 提供商未返回可读取的流。');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();

    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const messages = buffer.split(/\r?\n\r?\n/u);
    buffer = messages.pop() ?? '';

    for (const rawMessage of messages) {
      const event = parseSseMessage(rawMessage);
      if (event) {
        onEvent(event);
      }
    }
  }

  buffer += decoder.decode();

  if (buffer.trim()) {
    const event = parseSseMessage(buffer);
    if (event) {
      onEvent(event);
    }
  }
}

async function requestAiChat(rawRequest) {
  const request = readAiChatRequest(rawRequest);
  const endpoint = createChatEndpoint(request.apiFormat, request.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), chatTimeoutMs);
  const headers = createChatHeaders(request);
  const body = createChatPayload(request);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const responseText = await response.text();
    const payload = parseJsonResponse(responseText);

    if (!response.ok) {
      throw new Error(readErrorMessage(payload, responseText));
    }

    return {
      endpoint,
      content: request.apiFormat === 'anthropic'
        ? readAnthropicChatContent(payload)
        : readOpenAiChatContent(payload),
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('SD-Agent 请求超时。');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function requestAiChatStream(event, rawRequest) {
  const request = readAiChatStreamRequest(rawRequest);
  const endpoint = createChatEndpoint(request.apiFormat, request.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), chatStreamTimeoutMs);
  const headers = createChatHeaders(request);
  const body = createChatPayload(request, true);
  let content = '';

  headers.accept = 'text/event-stream';

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const responseText = await response.text();
      throw new Error(readErrorMessage(parseJsonResponse(responseText), responseText));
    }

    await readEventStream(response, ({ data }) => {
      if (data === '[DONE]') {
        return;
      }

      const payload = parseJsonResponse(data);

      if (!payload) {
        return;
      }

      const chunk = request.apiFormat === 'anthropic'
        ? extractAnthropicStreamDelta(payload)
        : extractOpenAiStreamDelta(payload);

      if (!chunk) {
        return;
      }

      content += chunk;
      event.sender.send('ai:chat-stream:chunk', {
        streamId: request.streamId,
        chunk,
      });
    });

    if (!content.trim()) {
      throw new Error('SD-Agent 响应为空。');
    }

    return {
      endpoint,
      content,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('SD-Agent 流式请求超时。');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function listAiModels(rawRequest) {
  const request = readAiModelListRequest(rawRequest);
  const endpoint = createModelsEndpoint(request.apiFormat, request.apiBaseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), modelListTimeoutMs);
  const headers = {
    accept: 'application/json',
  };

  if (request.apiFormat === 'anthropic') {
    headers['x-api-key'] = request.apiKey;
    headers['anthropic-version'] = anthropicApiVersion;
  } else {
    headers.authorization = `Bearer ${request.apiKey}`;
  }

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const responseText = await response.text();
    const payload = parseJsonResponse(responseText);

    if (!response.ok) {
      throw new Error(readErrorMessage(payload, responseText));
    }

    const models = parseModelList(payload);

    if (!models.length) {
      throw new Error('未从提供商返回可用模型。');
    }

    return {
      endpoint,
      models,
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('获取模型列表超时。');
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function registerAiHandlers(registerIpcHandler) {
  registerIpcHandler('ai:list-models', async (_event, rawRequest) => listAiModels(rawRequest));
  registerIpcHandler('ai:chat', async (_event, rawRequest) => requestAiChat(rawRequest));
  registerIpcHandler('ai:chat-stream', async (event, rawRequest) => requestAiChatStream(event, rawRequest));
}

module.exports = { registerAiHandlers };
