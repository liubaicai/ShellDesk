import { createElement, useEffect, useMemo, useRef, type ReactNode } from 'react';

interface MarkdownReportProps {
  className: string;
  content: string;
  placeholder: string;
  renderMarkdown?: boolean;
  stickToBottom?: boolean;
}

function isSafeUrl(value: string) {
  return /^(https?:|mailto:)/i.test(value);
}

function parseTableRow(line: string) {
  return line
    .replace(/^\s*\|?|\|?\s*$/g, '')
    .split('|')
    .map((cell) => cell.trim());
}

function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isBlockStart(lines: string[], index: number) {
  const line = lines[index] ?? '';

  return /^#{1,6}\s+/.test(line)
    || /^```/.test(line)
    || /^>\s?/.test(line)
    || /^\s*[-*]\s+/.test(line)
    || /^\s*\d+\.\s+/.test(line)
    || (line.includes('|') && isTableSeparator(lines[index + 1] ?? ''));
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;

    if (token.startsWith('**')) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('`')) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else {
      const linkMatch = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const label = linkMatch?.[1] ?? token;
      const href = linkMatch?.[2] ?? '';

      nodes.push(isSafeUrl(href)
        ? <a key={key} href={href} target="_blank" rel="noreferrer">{label}</a>
        : <span key={key}>{label}</span>);
    }

    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}

function renderMarkdown(content: string) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const codeFence = line.match(/^```\s*(\S+)?/);
    if (codeFence) {
      const language = codeFence[1] ?? '';
      const codeLines: string[] = [];
      index += 1;

      while (index < lines.length && !/^```/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }

      if (index < lines.length) {
        index += 1;
      }

      blocks.push(
        <pre key={`code-${index}`} className={language ? `language-${language}` : undefined}>
          <code>{codeLines.join('\n')}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(createElement(
        `h${level}`,
        { key: `heading-${index}` },
        renderInline(heading[2].trim(), `heading-${index}`),
      ));
      index += 1;
      continue;
    }

    if (line.includes('|') && isTableSeparator(lines[index + 1] ?? '')) {
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      index += 2;

      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }

      blocks.push(
        <div key={`table-${index}`} className="markdown-table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((header, headerIndex) => (
                  <th key={`${header}-${headerIndex}`}>{renderInline(header, `th-${index}-${headerIndex}`)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={`row-${index}-${rowIndex}`}>
                  {headers.map((_, cellIndex) => (
                    <td key={`cell-${index}-${rowIndex}-${cellIndex}`}>
                      {renderInline(row[cellIndex] ?? '', `td-${index}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
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
        <li key={`${itemIndex}-${item}`}>{renderInline(item, `li-${index}-${itemIndex}`)}</li>
      ));
      blocks.push(ordered ? <ol key={`ol-${index}`}>{listItems}</ol> : <ul key={`ul-${index}`}>{listItems}</ul>);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];

      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoteLines.push(lines[index].replace(/^>\s?/, ''));
        index += 1;
      }

      blocks.push(
        <blockquote key={`quote-${index}`}>
          {quoteLines.map((quoteLine, quoteIndex) => (
            <p key={`${quoteIndex}-${quoteLine}`}>{renderInline(quoteLine, `quote-${index}-${quoteIndex}`)}</p>
          ))}
        </blockquote>,
      );
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;

    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraphLines.push(lines[index].trim());
      index += 1;
    }

    blocks.push(
      <p key={`p-${index}`}>{renderInline(paragraphLines.join(' '), `p-${index}`)}</p>,
    );
  }

  return blocks;
}

function MarkdownReport({
  className,
  content,
  placeholder,
  renderMarkdown: shouldRenderMarkdown = true,
  stickToBottom = false,
}: MarkdownReportProps) {
  const reportRef = useRef<HTMLDivElement | null>(null);
  const renderedContent = useMemo(
    () => (shouldRenderMarkdown && content.trim() ? renderMarkdown(content) : null),
    [content, shouldRenderMarkdown],
  );

  useEffect(() => {
    if (!stickToBottom) {
      return;
    }

    const element = reportRef.current;

    if (!element) {
      return;
    }

    element.scrollTop = element.scrollHeight;
  }, [content, stickToBottom]);

  const hasContent = Boolean(content.trim());

  return (
    <div
      ref={reportRef}
      className={`${className} markdown-report ${hasContent ? '' : 'empty'} ${shouldRenderMarkdown ? '' : 'streaming'}`}
      data-i18n-skip
    >
      {!hasContent ? placeholder : shouldRenderMarkdown ? renderedContent : <pre className="markdown-stream-text">{content}</pre>}
    </div>
  );
}

export default MarkdownReport;
