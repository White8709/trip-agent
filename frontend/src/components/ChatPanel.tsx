import React, { useEffect, useRef, useState } from 'react';
import { ChatMessage, filterSafeWebSources } from '../lib/api';
import { getSourceHost, LinkifiedText } from './LinkifiedText';

interface ChatPanelProps {
  messages: ChatMessage[];
  sending: boolean;
  error: string | null;
  emptyTitle: string;
  emptySubtitle: string;
  starterPrompts: string[];
  placeholder: string;
  webSearchAvailable: boolean;
  webSearchEnabled: boolean;
  onToggleWebSearch: () => void;
  onSend: (text: string) => void;
}

export const ChatPanel: React.FC<ChatPanelProps> = ({
  messages,
  sending,
  error,
  emptyTitle,
  emptySubtitle,
  starterPrompts,
  placeholder,
  webSearchAvailable,
  webSearchEnabled,
  onToggleWebSearch,
  onSend,
}) => {
  const [input, setInput] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  const submitText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;
    setInput('');
    onSend(trimmed);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitText(input);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submitText(input);
    }
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {/* Message List */}
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-3">
        {messages.length === 0 ? (
          <div className="flex flex-col gap-3 py-2">
            <div className="rounded-xl bg-surface-container-low/70 dark:bg-[#22252D] p-4 flex items-start gap-3">
              <div className="w-8 h-8 rounded-full bg-primary-fixed/60 dark:bg-primary/20 text-primary dark:text-[#ff9c85] flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[18px]">forum</span>
              </div>
              <div className="min-w-0">
                <p className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-white mb-0.5">
                  {emptyTitle}
                </p>
                <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-slate-400 leading-relaxed">
                  {emptySubtitle}
                </p>
              </div>
            </div>

            <div className="flex flex-col gap-2">
              <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 px-1">
                試著這樣問：
              </span>
              {starterPrompts.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  disabled={sending}
                  onClick={() => submitText(prompt)}
                  className="text-left px-3.5 py-2.5 rounded-xl bg-surface-container-lowest dark:bg-[#24272E] border border-surface-container-high/80 dark:border-white/[0.08] text-body-sm text-on-surface dark:text-slate-200 hover:bg-surface-container-low dark:hover:bg-[#2C303A] active:scale-[0.99] transition-all flex items-center justify-between gap-2 disabled:opacity-50"
                >
                  <span>{prompt}</span>
                  <span className="material-symbols-outlined text-[16px] text-primary dark:text-[#ff9c85] shrink-0">
                    arrow_forward
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg, idx) => {
            const isUser = msg.role === 'user';
            const searchQueries =
              !isUser && Array.isArray(msg.search_queries)
                ? msg.search_queries.map((q) => q.trim()).filter(Boolean)
                : [];
            const safeSources = !isUser ? filterSafeWebSources(msg.sources) : [];
            return (
              <div
                key={idx}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-1.5`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-body-sm font-body-sm leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? 'bg-primary-container text-on-primary rounded-br-sm shadow-xs'
                      : 'bg-surface-container-low dark:bg-[#24272E] text-on-surface dark:text-slate-200 rounded-bl-sm'
                  }`}
                >
                  <LinkifiedText
                    text={msg.content}
                    linkClassName={
                      isUser
                        ? 'underline underline-offset-2 text-on-primary font-medium hover:opacity-90'
                        : 'underline underline-offset-2 text-secondary dark:text-sky-300 font-medium hover:opacity-80'
                    }
                  />
                </div>

                {(searchQueries.length > 0 || safeSources.length > 0) && (
                  <div className="max-w-[92%] flex flex-col gap-1.5 pl-0.5">
                    {searchQueries.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1">
                        {searchQueries.map((query, qIdx) => (
                          <a
                            key={`${query}-${qIdx}`}
                            href={`https://www.google.com/search?q=${encodeURIComponent(query)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`在 Google 查看「${query}」`}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-surface-container dark:bg-[#22252D] hover:bg-surface-container-high dark:hover:bg-[#2B303A] text-on-surface-variant dark:text-slate-300 text-label-sm font-label-sm transition-colors"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[12px] select-none"
                            >
                              search
                            </span>
                            <span>已搜尋：{query}</span>
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[11px] opacity-70 select-none"
                            >
                              open_in_new
                            </span>
                          </a>
                        ))}
                      </div>
                    )}

                    {safeSources.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {safeSources.map((src, sIdx) => {
                          const host = getSourceHost(src.url);
                          return (
                            <a
                              key={`${src.url}-${sIdx}`}
                              href={src.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={src.url}
                              className="inline-flex items-center gap-1 max-w-full px-2.5 py-1 rounded-full bg-secondary-fixed/40 dark:bg-sky-950/40 border border-secondary-fixed-dim/50 dark:border-sky-500/25 text-secondary dark:text-sky-300 hover:bg-secondary-fixed/70 dark:hover:bg-sky-900/50 text-label-sm font-label-sm transition-colors"
                            >
                              <span className="truncate max-w-[180px]">
                                {src.title || host || src.url}
                              </span>
                              {src.title && host && (
                                <span className="opacity-70 text-[10px] shrink-0">({host})</span>
                              )}
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[13px] shrink-0 select-none"
                              >
                                open_in_new
                              </span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}

        {sending && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-surface-container-low dark:bg-[#24272E] px-3.5 py-2.5 text-body-sm text-on-surface-variant dark:text-slate-300 inline-flex items-center gap-2">
              <span className="material-symbols-outlined text-[16px] animate-spin text-primary dark:text-[#ff9c85]">
                progress_activity
              </span>
              <span>
                {webSearchAvailable && webSearchEnabled
                  ? 'AI 思考與查詢網路資訊中...'
                  : 'AI 思考中...'}
              </span>
            </div>
          </div>
        )}

        {error && (
          <div className="rounded-xl bg-error-container/80 dark:bg-rose-950/60 border border-error/20 dark:border-rose-500/30 p-3 text-on-error-container dark:text-rose-200 text-body-sm flex items-start gap-2">
            <span className="material-symbols-outlined text-[17px] shrink-0 mt-0.5">
              error
            </span>
            <span className="leading-relaxed">{error}</span>
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* Bottom Sticky Input Bar */}
      <div className="px-4 pt-2 pb-3 bg-surface-container-low/90 dark:bg-[#14171D] border-t border-surface-container-high/60 dark:border-white/[0.08] flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2">
          {webSearchAvailable ? (
            <button
              type="button"
              onClick={onToggleWebSearch}
              disabled={sending}
              aria-pressed={webSearchEnabled}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-label-sm font-label-sm transition-all active:scale-95 disabled:opacity-60 ${
                webSearchEnabled
                  ? 'bg-tertiary-fixed/45 dark:bg-emerald-950/50 text-tertiary dark:text-emerald-300 border border-tertiary-fixed-dim/60 dark:border-emerald-500/30'
                  : 'bg-surface-container dark:bg-[#24272E] text-on-surface-variant dark:text-slate-400 border border-surface-container-high/70 dark:border-white/[0.08]'
              }`}
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[14px] select-none">public</span>
              <span>{webSearchEnabled ? '已開啟連網搜尋' : '連網搜尋已關閉'}</span>
            </button>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-label-sm font-label-sm bg-surface-container dark:bg-[#24272E] text-on-surface-variant/80 dark:text-slate-400 border border-surface-container-high/60 dark:border-white/[0.06]">
              <span aria-hidden="true" className="material-symbols-outlined text-[14px] select-none">public</span>
              <span>未設定 Tavily Key（純 AI 模式）</span>
            </span>
          )}
        </div>

        <form onSubmit={handleSubmit} className="flex items-center gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            placeholder={placeholder}
            className="flex-1 min-w-0 h-11 px-3.5 rounded-xl bg-surface-container-lowest dark:bg-[#22252D] text-body-md text-on-surface dark:text-slate-100 placeholder:text-on-surface-variant/55 dark:placeholder:text-slate-500 border border-surface-container-high dark:border-white/[0.08] focus:outline-none focus:ring-1 focus:ring-primary-container disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={!input.trim() || sending}
            aria-label="傳送訊息"
            className="w-11 h-11 rounded-xl bg-primary-container text-on-primary flex items-center justify-center shadow-sm hover:opacity-95 active:scale-95 transition-all shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <span className="material-symbols-outlined text-[20px]">send</span>
          </button>
        </form>
      </div>
    </div>
  );
};
