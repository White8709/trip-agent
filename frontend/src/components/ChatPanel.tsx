import React, { useEffect, useRef, useState } from 'react';
import { useVoiceTranscribe } from '../hooks/useVoiceTranscribe';
import { ChatMessage, filterSafeWebSources, generateChatAudio } from '../lib/api';
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

function combineBaseAndTranscript(base: string, transcript: string): string {
  const cleanTranscript = transcript.trim();
  if (!cleanTranscript) return base;
  if (!base) return cleanTranscript;
  if (/\s$/.test(base)) return `${base}${cleanTranscript}`;
  const lastChar = base[base.length - 1];
  const firstChar = cleanTranscript[0];
  if (/[A-Za-z0-9]/.test(lastChar) && /[A-Za-z0-9]/.test(firstChar)) {
    return `${base} ${cleanTranscript}`;
  }
  return `${base}${cleanTranscript}`;
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
  const [voiceError, setVoiceError] = useState<string | null>(null);

  const [audioUrlByIndex, setAudioUrlByIndex] = useState<Record<number, string>>({});
  const [loadingTtsIndex, setLoadingTtsIndex] = useState<number | null>(null);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const [ttsError, setTtsError] = useState<string | null>(null);

  const endRef = useRef<HTMLDivElement | null>(null);
  const baseInputBeforeRecordRef = useRef('');
  const ignoreVoiceUpdatesRef = useRef(false);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioContentByIndexRef = useRef<Record<number, string>>({});
  const loadedUrlRef = useRef<string | null>(null);
  const playingIndexRef = useRef<number | null>(null);
  const switchingAudioRef = useRef(false);
  const ttsReqSeqRef = useRef(0);
  const mountedRef = useRef(true);

  const {
    state: voiceState,
    start: startVoice,
    stop: stopVoice,
  } = useVoiceTranscribe({
    onTranscriptUpdate: (transcript) => {
      if (ignoreVoiceUpdatesRef.current) return;
      setInput(combineBaseAndTranscript(baseInputBeforeRecordRef.current, transcript));
    },
    onError: (msg) => {
      setVoiceError(msg);
    },
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, sending]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ttsReqSeqRef.current += 1;
      if (audioRef.current) {
        switchingAudioRef.current = true;
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
      }
    };
  }, []);

  useEffect(() => {
    if (messages.length === 0) {
      ttsReqSeqRef.current += 1;
      if (audioRef.current) {
        switchingAudioRef.current = true;
        audioRef.current.pause();
        audioRef.current.removeAttribute('src');
        audioRef.current.load();
      }
      loadedUrlRef.current = null;
      audioContentByIndexRef.current = {};
      playingIndexRef.current = null;
      setAudioUrlByIndex({});
      setLoadingTtsIndex(null);
      setPlayingIndex(null);
      setTtsError(null);
      return;
    }

    const staleIndices = Object.entries(audioContentByIndexRef.current)
      .filter(([idxStr, content]) => messages[Number(idxStr)]?.content !== content)
      .map(([idxStr]) => Number(idxStr));

    if (staleIndices.length > 0) {
      if (playingIndexRef.current !== null && staleIndices.includes(playingIndexRef.current)) {
        switchingAudioRef.current = true;
        audioRef.current?.pause();
        playingIndexRef.current = null;
        setPlayingIndex(null);
      }
      for (const idx of staleIndices) {
        delete audioContentByIndexRef.current[idx];
      }
      setAudioUrlByIndex((prev) => {
        const next = { ...prev };
        for (const idx of staleIndices) {
          delete next[idx];
        }
        return next;
      });
    }
  }, [messages]);

  const submitText = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || sending) return;

    if (voiceState === 'connecting' || voiceState === 'recording') {
      ignoreVoiceUpdatesRef.current = true;
      stopVoice();
    }
    baseInputBeforeRecordRef.current = '';
    setVoiceError(null);
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

  const handleToggleVoice = () => {
    if (voiceState === 'idle') {
      setVoiceError(null);
      ignoreVoiceUpdatesRef.current = false;
      baseInputBeforeRecordRef.current = input;
      void startVoice();
    } else if (voiceState === 'connecting' || voiceState === 'recording') {
      stopVoice();
    }
  };

  const playUrlForIndex = async (idx: number, url: string) => {
    const audio = audioRef.current;
    if (!audio) return;

    if (!audio.paused) {
      switchingAudioRef.current = true;
      audio.pause();
    }
    if (loadedUrlRef.current !== url) {
      switchingAudioRef.current = true;
      audio.src = url;
      audio.currentTime = 0;
      loadedUrlRef.current = url;
    } else if (audio.ended) {
      audio.currentTime = 0;
    }

    playingIndexRef.current = idx;
    setPlayingIndex(idx);
    try {
      await audio.play();
    } catch {
      switchingAudioRef.current = false;
      if (mountedRef.current) {
        playingIndexRef.current = null;
        setPlayingIndex(null);
        setTtsError('瀏覽器無法播放此語音，請再試一次。');
      }
    }
  };

  const handleTtsClick = async (idx: number, text: string) => {
    if (loadingTtsIndex === idx) return;
    setTtsError(null);

    if (playingIndexRef.current === idx) {
      switchingAudioRef.current = false;
      audioRef.current?.pause();
      playingIndexRef.current = null;
      setPlayingIndex(null);
      return;
    }

    const cachedUrl = audioUrlByIndex[idx];
    if (cachedUrl && audioContentByIndexRef.current[idx] === text) {
      await playUrlForIndex(idx, cachedUrl);
      return;
    }

    const reqSeq = ttsReqSeqRef.current + 1;
    ttsReqSeqRef.current = reqSeq;

    if (audioRef.current && !audioRef.current.paused) {
      switchingAudioRef.current = true;
      audioRef.current.pause();
      playingIndexRef.current = null;
      setPlayingIndex(null);
    }

    setLoadingTtsIndex(idx);
    try {
      const audioUrl = await generateChatAudio(text);
      if (!mountedRef.current) return;
      audioContentByIndexRef.current[idx] = text;
      setAudioUrlByIndex((prev) => ({ ...prev, [idx]: audioUrl }));

      if (ttsReqSeqRef.current === reqSeq) {
        setLoadingTtsIndex(null);
        await playUrlForIndex(idx, audioUrl);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      if (ttsReqSeqRef.current === reqSeq) {
        setLoadingTtsIndex(null);
        setTtsError(err instanceof Error ? err.message : '語音生成失敗，請稍後再試。');
      }
    }
  };

  const webSearchLabel = !webSearchAvailable
    ? '未設定連網搜尋（純 AI 模式）'
    : webSearchEnabled
      ? '關閉連網搜尋'
      : '開啟連網搜尋';

  const webSearchTitle = !webSearchAvailable
    ? '未設定 Tavily Key（純 AI 模式）'
    : webSearchEnabled
      ? '連網搜尋：已開啟（點擊關閉）'
      : '連網搜尋：已關閉（點擊開啟）';

  const voiceIcon =
    voiceState === 'recording'
      ? 'stop'
      : voiceState === 'connecting' || voiceState === 'finishing'
        ? 'progress_activity'
        : 'mic';

  const voiceLabel =
    voiceState === 'recording'
      ? '停止語音輸入'
      : voiceState === 'connecting'
        ? '正在連線語音輸入'
        : voiceState === 'finishing'
          ? '正在完成語音辨識'
          : '開始語音輸入';

  const voiceTitle =
    voiceState === 'recording'
      ? '停止語音輸入'
      : voiceState === 'connecting'
        ? '正在連線 Gemini Live 語音辨識...'
        : voiceState === 'finishing'
          ? '正在完成語音辨識...'
          : '即時語音輸入';

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <audio
        ref={audioRef}
        className="hidden"
        onPlay={() => {
          switchingAudioRef.current = false;
        }}
        onEnded={() => {
          switchingAudioRef.current = false;
          playingIndexRef.current = null;
          setPlayingIndex(null);
        }}
        onPause={() => {
          if (switchingAudioRef.current) return;
          if (audioRef.current?.paused) {
            playingIndexRef.current = null;
            setPlayingIndex(null);
          }
        }}
        onError={() => {
          if (!loadedUrlRef.current) return;
          switchingAudioRef.current = false;
          playingIndexRef.current = null;
          setPlayingIndex(null);
          setTtsError('語音載入或播放失敗，請稍後再試。');
        }}
      />

      {/* Message List */}
      <div className="flex-1 overflow-y-auto overscroll-contain px-4 sm:px-5 md:px-6 xl:px-5 py-4 flex flex-col gap-3">
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

            const isGeneratingTts = !isUser && loadingTtsIndex === idx;
            const isPlayingTts = !isUser && playingIndex === idx;
            const hasCachedTts =
              !isUser &&
              Boolean(audioUrlByIndex[idx]) &&
              audioContentByIndexRef.current[idx] === msg.content;

            const ttsIcon = isGeneratingTts
              ? 'progress_activity'
              : isPlayingTts
                ? 'pause'
                : hasCachedTts
                  ? 'play_arrow'
                  : 'volume_up';
            const ttsAriaLabel = isGeneratingTts
              ? '正在生成語音'
              : isPlayingTts
                ? '暫停語音'
                : hasCachedTts
                  ? '播放語音'
                  : '生成並播放語音';
            const ttsTitle = isGeneratingTts
              ? '正在生成語音...'
              : isPlayingTts
                ? '暫停語音'
                : hasCachedTts
                  ? '播放語音'
                  : '朗讀此回覆';

            return (
              <div
                key={idx}
                className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} gap-1.5`}
              >
                <div
                  className={`max-w-[88%] sm:max-w-[82%] md:max-w-[78%] rounded-2xl px-3.5 py-2.5 text-body-sm font-body-sm leading-relaxed whitespace-pre-wrap break-words ${
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

                {!isUser && (
                  <div className="flex items-center gap-1.5 pl-0.5">
                    <button
                      type="button"
                      onClick={() => void handleTtsClick(idx, msg.content)}
                      disabled={isGeneratingTts || !msg.content.trim()}
                      aria-label={ttsAriaLabel}
                      title={ttsTitle}
                      className={`w-8 h-8 rounded-full flex items-center justify-center transition-all active:scale-95 disabled:opacity-55 ${
                        isPlayingTts
                          ? 'bg-primary-container text-on-primary shadow-xs'
                          : hasCachedTts
                            ? 'bg-primary-fixed/55 dark:bg-primary/20 text-primary dark:text-[#ff9c85] hover:bg-primary-fixed dark:hover:bg-primary/30'
                            : 'bg-surface-container dark:bg-[#24272E] text-on-surface-variant dark:text-slate-300 border border-surface-container-high/70 dark:border-white/[0.08] hover:bg-surface-container-high dark:hover:bg-[#2C303A]'
                      }`}
                    >
                      <span
                        aria-hidden="true"
                        className={`material-symbols-outlined text-[17px] select-none ${
                          isGeneratingTts ? 'animate-spin' : ''
                        }`}
                      >
                        {ttsIcon}
                      </span>
                    </button>
                  </div>
                )}

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
                              <span className="truncate max-w-[180px] sm:max-w-[260px] xl:max-w-[200px] 2xl:max-w-[240px]">
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

      {/* Bottom Sticky Single-Row Icon-Only Input Bar */}
      <div className="px-3 sm:px-4 md:px-5 py-2.5 sm:py-3 bg-surface-container-low/90 dark:bg-[#14171D] border-t border-surface-container-high/60 dark:border-white/[0.08] flex flex-col gap-2 shrink-0">
        {voiceError && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-error-container/80 dark:bg-rose-950/60 border border-error/20 dark:border-rose-500/30 text-on-error-container dark:text-rose-200 text-label-sm font-label-sm">
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="material-symbols-outlined text-[15px] shrink-0 select-none">
                mic_off
              </span>
              <span className="truncate">{voiceError}</span>
            </div>
            <button
              type="button"
              onClick={() => setVoiceError(null)}
              aria-label="關閉語音錯誤提示"
              title="關閉語音錯誤提示"
              className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[14px] select-none">
                close
              </span>
            </button>
          </div>
        )}

        {ttsError && (
          <div className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-error-container/80 dark:bg-rose-950/60 border border-error/20 dark:border-rose-500/30 text-on-error-container dark:text-rose-200 text-label-sm font-label-sm">
            <div className="flex items-center gap-1.5 min-w-0">
              <span aria-hidden="true" className="material-symbols-outlined text-[15px] shrink-0 select-none">
                volume_off
              </span>
              <span className="truncate">{ttsError}</span>
            </div>
            <button
              type="button"
              onClick={() => setTtsError(null)}
              aria-label="關閉語音播放錯誤提示"
              title="關閉語音播放錯誤提示"
              className="shrink-0 w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/10 dark:hover:bg-white/10"
            >
              <span aria-hidden="true" className="material-symbols-outlined text-[14px] select-none">
                close
              </span>
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onToggleWebSearch}
            disabled={sending || !webSearchAvailable}
            aria-pressed={webSearchAvailable ? webSearchEnabled : false}
            aria-label={webSearchLabel}
            title={webSearchTitle}
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 transition-all active:scale-95 ${
              !webSearchAvailable
                ? 'bg-surface-container dark:bg-[#24272E] text-on-surface-variant/50 dark:text-slate-500 border border-surface-container-high/50 dark:border-white/[0.05] opacity-50 cursor-not-allowed'
                : webSearchEnabled
                  ? 'bg-tertiary-fixed/45 dark:bg-emerald-950/50 text-tertiary dark:text-emerald-300 border border-tertiary-fixed-dim/60 dark:border-emerald-500/30 disabled:opacity-60'
                  : 'bg-surface-container dark:bg-[#24272E] text-on-surface-variant dark:text-slate-400 border border-surface-container-high/70 dark:border-white/[0.08] hover:bg-surface-container-high dark:hover:bg-[#2C303A] disabled:opacity-60'
            }`}
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[20px] select-none">
              public
            </span>
          </button>

          <button
            type="button"
            onClick={handleToggleVoice}
            disabled={sending || voiceState === 'finishing'}
            aria-pressed={voiceState === 'recording'}
            aria-label={voiceLabel}
            title={voiceTitle}
            className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl flex items-center justify-center shrink-0 transition-all active:scale-95 disabled:opacity-55 ${
              voiceState === 'recording'
                ? 'bg-rose-500 text-white border border-rose-500 shadow-sm animate-pulse'
                : voiceState === 'connecting' || voiceState === 'finishing'
                  ? 'bg-primary-fixed/60 dark:bg-primary/20 text-primary dark:text-[#ff9c85] border border-primary/30'
                  : 'bg-surface-container dark:bg-[#24272E] text-on-surface-variant dark:text-slate-300 border border-surface-container-high/70 dark:border-white/[0.08] hover:bg-surface-container-high dark:hover:bg-[#2C303A]'
            }`}
          >
            <span
              aria-hidden="true"
              className={`material-symbols-outlined text-[20px] select-none ${
                voiceState === 'connecting' || voiceState === 'finishing' ? 'animate-spin' : ''
              }`}
            >
              {voiceIcon}
            </span>
          </button>

          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={sending}
            placeholder={placeholder}
            className="flex-1 min-w-0 h-9 sm:h-10 px-3 rounded-xl bg-surface-container-lowest dark:bg-[#22252D] text-body-md text-on-surface dark:text-slate-100 placeholder:text-on-surface-variant/55 dark:placeholder:text-slate-500 border border-surface-container-high dark:border-white/[0.08] focus:outline-none focus:ring-1 focus:ring-primary-container disabled:opacity-60"
          />

          <button
            type="submit"
            disabled={!input.trim() || sending}
            aria-label="傳送訊息"
            title="傳送訊息"
            className="w-9 h-9 sm:w-10 sm:h-10 rounded-xl bg-primary-container text-on-primary flex items-center justify-center shadow-sm hover:opacity-95 active:scale-95 transition-all shrink-0 disabled:opacity-45 disabled:cursor-not-allowed"
          >
            <span aria-hidden="true" className="material-symbols-outlined text-[20px] select-none">
              send
            </span>
          </button>
        </form>
      </div>
    </div>
  );
};
