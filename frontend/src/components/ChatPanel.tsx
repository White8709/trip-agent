import React, { useEffect, useRef, useState } from 'react';
import { ChatMessage } from '../lib/api';

interface ChatPanelProps {
  messages: ChatMessage[];
  sending: boolean;
  error: string | null;
  emptyTitle: string;
  emptySubtitle: string;
  starterPrompts: string[];
  placeholder: string;
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
            return (
              <div
                key={idx}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-body-sm font-body-sm leading-relaxed whitespace-pre-wrap break-words ${
                    isUser
                      ? 'bg-primary-container text-on-primary rounded-br-sm shadow-xs'
                      : 'bg-surface-container-low dark:bg-[#24272E] text-on-surface dark:text-slate-200 rounded-bl-sm'
                  }`}
                >
                  {msg.content}
                </div>
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
              <span>AI 思考中...</span>
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
      <form
        onSubmit={handleSubmit}
        className="px-4 py-3 bg-surface-container-low/90 dark:bg-[#14171D] border-t border-surface-container-high/60 dark:border-white/[0.08] flex items-center gap-2 shrink-0"
      >
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
  );
};
