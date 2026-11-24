import React from 'react';

interface LinkifiedTextProps {
  text: string;
  linkClassName?: string;
}

const TOKEN_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>]+)/g;
const TRAILING_PUNCT_RE = /[.,;:!?。，、；：！？\]】」』"'》〉）]$/;

function splitBareUrlTrailing(rawUrl: string): { url: string; trailing: string } {
  let url = rawUrl;
  let trailing = '';

  while (url.length > 0) {
    const lastChar = url[url.length - 1];
    if (TRAILING_PUNCT_RE.test(lastChar)) {
      trailing = lastChar + trailing;
      url = url.slice(0, -1);
      continue;
    }
    if (lastChar === ')') {
      const openCount = (url.match(/\(/g) ?? []).length;
      const closeCount = (url.match(/\)/g) ?? []).length;
      if (closeCount > openCount) {
        trailing = lastChar + trailing;
        url = url.slice(0, -1);
        continue;
      }
    }
    break;
  }

  return { url, trailing };
}

export function getSourceHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Safely renders plain text containing Markdown `[label](https://...)` or bare `http(s)://...` URLs
 * as clickable external anchor elements without using `dangerouslySetInnerHTML`.
 */
export const LinkifiedText: React.FC<LinkifiedTextProps> = ({
  text,
  linkClassName = 'underline underline-offset-2 text-secondary dark:text-sky-300 font-medium hover:opacity-80',
}) => {
  const nodes: React.ReactNode[] = [];
  let lastIndex = 0;
  const re = new RegExp(TOKEN_RE.source, 'g');
  let match: RegExpExecArray | null;
  let keyCounter = 0;

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }

    const mdLabel = match[1];
    const mdUrl = match[2];
    const bareRawUrl = match[3];

    if (mdLabel && mdUrl && /^https?:\/\//i.test(mdUrl)) {
      nodes.push(
        <a
          key={`lnk-${keyCounter++}`}
          href={mdUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={mdUrl}
          className={`inline-flex items-baseline gap-0.5 break-all ${linkClassName}`}
        >
          <span>{mdLabel}</span>
          <span
            aria-hidden="true"
            className="material-symbols-outlined text-[13px] self-center select-none shrink-0"
          >
            open_in_new
          </span>
        </a>,
      );
    } else if (bareRawUrl) {
      const { url, trailing } = splitBareUrlTrailing(bareRawUrl);
      if (/^https?:\/\//i.test(url)) {
        nodes.push(
          <a
            key={`lnk-${keyCounter++}`}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={url}
            className={`inline-flex items-baseline gap-0.5 break-all ${linkClassName}`}
          >
            <span>{url}</span>
            <span
              aria-hidden="true"
              className="material-symbols-outlined text-[13px] self-center select-none shrink-0"
            >
              open_in_new
            </span>
          </a>,
        );
        if (trailing) {
          nodes.push(trailing);
        }
      } else {
        nodes.push(match[0]);
      }
    } else {
      nodes.push(match[0]);
    }

    lastIndex = re.lastIndex;
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return <>{nodes}</>;
};
