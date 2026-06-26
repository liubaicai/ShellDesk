import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEFAULT_CHAT_PROMPT, useAiChat } from '../../ai';
import { tCurrent, type AppLanguage } from '../../i18n';

interface RemoteAiChatProps {
  settings: ShellDeskAppSettings;
  language: AppLanguage;
  onOpenSettings?: () => void;
}

interface MarkdownCodeBlock {
  type: 'code';
  content: string;
  language: string;
}

interface MarkdownTextBlock {
  type: 'text';
  content: string;
}

type MarkdownBlock = MarkdownCodeBlock | MarkdownTextBlock;

function parseMarkdownBlocks(content: string): MarkdownBlock[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let textLines: string[] = [];
  let codeLines: string[] = [];
  let codeLanguage = '';
  let inCode = false;

  const flushText = () => {
    const text = textLines.join('\n').trim();

    if (text) {
      blocks.push({ type: 'text', content: text });
    }

    textLines = [];
  };

  for (const line of lines) {
    const codeFenceMatch = line.match(/^```\s*([\w-]*)\s*$/);

    if (codeFenceMatch) {
      if (inCode) {
        blocks.push({ type: 'code', content: codeLines.join('\n'), language: codeLanguage });
        codeLines = [];
        codeLanguage = '';
        inCode = false;
      } else {
        flushText();
        inCode = true;
        codeLanguage = codeFenceMatch[1] ?? '';
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
    } else {
      textLines.push(line);
    }
  }

  if (inCode) {
    blocks.push({ type: 'code', content: codeLines.join('\n'), language: codeLanguage });
  }

  flushText();
  return blocks;
}

function renderInlineMarkdown(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    nodes.push(token.startsWith('**')
      ? <strong key={key}>{token.slice(2, -2)}</strong>
      : <code key={key}>{token.slice(1, -1)}</code>);
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderTextMarkdown(content: string, keyPrefix: string) {
  const lines = content.split('\n');
  const elements: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];

      while (index < lines.length) {
        const itemMatch = ordered
          ? lines[index].match(/^\s*\d+\.\s+(.+)$/)
          : lines[index].match(/^\s*[-*]\s+(.+)$/);

        if (!itemMatch) {
          break;
        }

        items.push(itemMatch[1]);
        index += 1;
      }

      const listItems = items.map((item, itemIndex) => (
        <li key={`${keyPrefix}-li-${itemIndex}`}>{renderInlineMarkdown(item, `${keyPrefix}-li-${itemIndex}`)}</li>
      ));
      elements.push(ordered
        ? <ol key={`${keyPrefix}-ol-${index}`}>{listItems}</ol>
        : <ul key={`${keyPrefix}-ul-${index}`}>{listItems}</ul>);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;

    while (index < lines.length && lines[index].trim() && !/^\s*(?:[-*]|\d+\.)\s+/.test(lines[index])) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    elements.push(
      <p key={`${keyPrefix}-p-${index}`}>
        {renderInlineMarkdown(paragraphLines.join(' '), `${keyPrefix}-p-${index}`)}
      </p>,
    );
  }

  return elements;
}

function MarkdownMessage({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(content), [content]);
  const [copiedBlock, setCopiedBlock] = useState<number | null>(null);

  const copyCode = useCallback(async (contentToCopy: string, blockIndex: number) => {
    await navigator.clipboard?.writeText(contentToCopy);
    setCopiedBlock(blockIndex);
    window.setTimeout(() => setCopiedBlock(null), 1200);
  }, []);

  return (
    <div className="ai-chat-markdown" data-i18n-skip>
      {blocks.map((block, blockIndex) => {
        if (block.type === 'code') {
          return (
            <div className="ai-chat-code-block" key={`code-${blockIndex}`}>
              <div className="ai-chat-code-header">
                <span>{block.language || tCurrent('auto.aiChat.code')}</span>
                <button type="button" onClick={() => void copyCode(block.content, blockIndex)}>
                  {copiedBlock === blockIndex ? tCurrent('auto.aiChat.copied') : tCurrent('auto.aiChat.copy')}
                </button>
              </div>
              <pre><code>{block.content}</code></pre>
            </div>
          );
        }

        return <div key={`text-${blockIndex}`}>{renderTextMarkdown(block.content, `block-${blockIndex}`)}</div>;
      })}
    </div>
  );
}

function RemoteAiChat({ settings, language, onOpenSettings }: RemoteAiChatProps) {
  const [draft, setDraft] = useState('');
  const messagesRef = useRef<HTMLDivElement | null>(null);
  const {
    messages,
    isBusy,
    error,
    isConfigured,
    sendMessage,
    clearHistory,
  } = useAiChat({
    settings,
    language,
    systemPrompt: DEFAULT_CHAT_PROMPT,
  });

  useEffect(() => {
    const element = messagesRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages, isBusy]);

  const sendDraft = useCallback(() => {
    const content = draft.trim();

    if (!content || isBusy) {
      return;
    }

    setDraft('');
    void sendMessage(content);
  }, [draft, isBusy, sendMessage]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendDraft();
    }
  }, [sendDraft]);

  const modelLabel = settings.aiModel.trim() || tCurrent('auto.aiChat.modelUnset');
  const sendDisabled = !draft.trim() || isBusy || !isConfigured;

  return (
    <div className="remote-ai-chat">
      <header className="ai-chat-header">
        <div>
          <h2>{tCurrent('auto.aiChat.title')}</h2>
          <span>{tCurrent('auto.aiChat.model', { value0: modelLabel })}</span>
        </div>
        <button type="button" onClick={clearHistory} disabled={!messages.length || isBusy}>
          {tCurrent('auto.aiChat.clear')}
        </button>
      </header>

      {!isConfigured ? (
        <div className="ai-chat-not-configured">
          <strong>{tCurrent('auto.aiChat.notConfiguredTitle')}</strong>
          <p>{tCurrent('auto.aiChat.notConfiguredSummary')}</p>
          {onOpenSettings ? (
            <button type="button" onClick={onOpenSettings}>{tCurrent('auto.aiChat.openSettings')}</button>
          ) : null}
        </div>
      ) : null}

      <div ref={messagesRef} className="ai-chat-messages">
        {!messages.length ? (
          <div className="ai-chat-empty">
            <strong>{tCurrent('auto.aiChat.emptyTitle')}</strong>
            <p>{tCurrent('auto.aiChat.emptySummary')}</p>
          </div>
        ) : null}
        {messages.map((message) => (
          <article key={message.id} className={`ai-chat-message ${message.role}`}>
            <div className="ai-chat-message-meta">
              <span>{message.role === 'user' ? tCurrent('auto.aiChat.user') : tCurrent('auto.aiChat.assistant')}</span>
              <time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString()}</time>
            </div>
            {message.role === 'assistant'
              ? <MarkdownMessage content={message.content} />
              : <p data-i18n-skip>{message.content}</p>}
          </article>
        ))}
        {isBusy ? <div className="ai-chat-thinking">{tCurrent('auto.aiChat.thinking')}</div> : null}
      </div>

      {error ? <div className="ai-chat-error">{error}</div> : null}

      <footer className="ai-chat-input">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={tCurrent('auto.aiChat.placeholder')}
          disabled={!isConfigured}
          rows={3}
        />
        <button type="button" onClick={sendDraft} disabled={sendDisabled}>
          {isBusy ? tCurrent('auto.aiChat.sending') : tCurrent('auto.aiChat.send')}
        </button>
      </footer>
    </div>
  );
}

export default RemoteAiChat;
