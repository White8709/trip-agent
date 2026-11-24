import React, { useEffect, useRef, useState } from 'react';
import {
  ChatMessage,
  chatWithItem,
  filterSafeWebSources,
  generateGuide,
  generateGuideAudio,
  getGuide,
  Guide,
  GuideStyle,
  TripItem,
} from '../lib/api';
import { formatStayDuration } from '../lib/parser';
import { ChatPanel } from './ChatPanel';
import { getSourceHost, LinkifiedText } from './LinkifiedText';

interface AiGuideSheetProps {
  item: TripItem | null;
  webSearchAvailable: boolean;
  fontSizeLabel: string;
  onCycleFontSize: () => void;
  onClose: () => void;
  onStyleCached: (itemId: number, style: GuideStyle) => void;
}

const STYLE_OPTIONS: { id: GuideStyle; label: string; icon: string }[] = [
  { id: 'cultural', label: '深度文化', icon: 'museum' },
  { id: 'casual', label: '輕鬆口語', icon: 'chat_bubble' },
  { id: 'family', label: '親子友善', icon: 'family_restroom' },
];

const PLAYBACK_RATES = [1, 1.25, 1.5] as const;

const ITEM_STARTER_PROMPTS = [
  '這裡最推薦的必看或必拍亮點是什麼？',
  '附近有推薦的美食或伴手禮嗎？',
  '預計停留時間夠逛嗎？怎麼逛最順？',
];

type SheetTab = 'guide' | 'chat';

function formatAudioSeconds(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '00:00';
  const total = Math.floor(sec);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const AiGuideSheet: React.FC<AiGuideSheetProps> = ({
  item,
  webSearchAvailable,
  fontSizeLabel,
  onCycleFontSize,
  onClose,
  onStyleCached,
}) => {
  const [activeTab, setActiveTab] = useState<SheetTab>('guide');
  const [style, setStyle] = useState<GuideStyle>('cultural');
  const [guide, setGuide] = useState<Guide | null>(null);
  const [loadingText, setLoadingText] = useState(false);
  const [loadingAudio, setLoadingAudio] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  // Per-item AI chat state
  const [chatByItem, setChatByItem] = useState<Record<number, ChatMessage[]>>({});
  const [chatSending, setChatSending] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(webSearchAvailable);

  useEffect(() => {
    setWebSearchEnabled(webSearchAvailable);
  }, [webSearchAvailable]);

  // Audio player state
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rateIndex, setRateIndex] = useState(0);

  // Reset default tab & style when opening a different item
  useEffect(() => {
    if (item) {
      setActiveTab('guide');
      setStyle(item.cached_styles[0] ?? 'cultural');
      setGuide(null);
      setError(null);
      setChatError(null);
    }
  }, [item?.item_id]);

  // Escape key closes sheet
  useEffect(() => {
    if (!item) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, onClose]);

  // Reset audio playback state whenever audio URL changes
  useEffect(() => {
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
  }, [guide?.audio_url, item?.item_id, style]);

  // Sync playback speed
  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.playbackRate = PLAYBACK_RATES[rateIndex];
    }
  }, [rateIndex, guide?.audio_url]);

  // Load cached guide or generate automatically
  useEffect(() => {
    if (!item) return;
    let cancelled = false;

    const loadOrGenerate = async () => {
      setLoadingText(true);
      setError(null);
      setGuide(null);
      try {
        const cached = await getGuide(item.item_id, style);
        if (cancelled) return;
        if (cached) {
          setGuide(cached);
          onStyleCached(item.item_id, style);
          setLoadingText(false);
          return;
        }
        const created = await generateGuide(item.item_id, style, false);
        if (cancelled) return;
        setGuide(created);
        onStyleCached(item.item_id, style);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '生成導覽失敗，請稍後再試。');
      } finally {
        if (!cancelled) setLoadingText(false);
      }
    };

    void loadOrGenerate();
    return () => {
      cancelled = true;
    };
  }, [item?.item_id, style, reloadNonce]);

  if (!item) return null;

  const handleRegenerateText = async () => {
    if (!item || loadingText) return;
    setLoadingText(true);
    setError(null);
    try {
      const updated = await generateGuide(item.item_id, style, true);
      setGuide(updated);
      onStyleCached(item.item_id, style);
    } catch (err) {
      setError(err instanceof Error ? err.message : '重新生成文案失敗，請稍後再試。');
    } finally {
      setLoadingText(false);
    }
  };

  const handleGenerateAudio = async (force = false) => {
    if (!item || !guide || loadingAudio) return;
    setLoadingAudio(true);
    setError(null);
    try {
      const audioUrl = await generateGuideAudio(item.item_id, style, force);
      setGuide((prev) =>
        prev
          ? {
              ...prev,
              audio_url: force ? `${audioUrl}?t=${Date.now()}` : audioUrl,
            }
          : prev,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成語音失敗，請稍後再試。');
    } finally {
      setLoadingAudio(false);
    }
  };

  const togglePlay = async () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) {
      try {
        await audio.play();
      } catch {
        setError('瀏覽器無法播放此音訊，請再試一次。');
      }
    } else {
      audio.pause();
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Number.parseFloat(e.target.value);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };

  const cycleRate = () => {
    setRateIndex((prev) => (prev + 1) % PLAYBACK_RATES.length);
  };

  const itemMessages = chatByItem[item.item_id] ?? [];

  const handleSendChat = async (text: string) => {
    if (chatSending) return;
    const itemId = item.item_id;
    const nextMessages = [...itemMessages, { role: 'user' as const, content: text }];

    setChatByItem((prev) => ({
      ...prev,
      [itemId]: nextMessages,
    }));
    setChatSending(true);
    setChatError(null);

    try {
      const result = await chatWithItem(
        itemId,
        nextMessages,
        webSearchAvailable && webSearchEnabled,
      );
      setChatByItem((prev) => ({
        ...prev,
        [itemId]: [
          ...(prev[itemId] ?? nextMessages),
          {
            role: 'model',
            content: result.reply,
            sources: result.sources,
            search_queries: result.search_queries,
          },
        ],
      }));
    } catch (err) {
      setChatError(err instanceof Error ? err.message : 'AI 回覆失敗，請稍後再試。');
    } finally {
      setChatSending(false);
    }
  };

  const handleClearChat = () => {
    const itemId = item.item_id;
    setChatByItem((prev) => {
      const next = { ...prev };
      delete next[itemId];
      return next;
    });
    setChatError(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#1A202C]/35 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-sheet-up w-full max-w-[430px] h-[85dvh] bg-surface-container-lowest dark:bg-[#1A1D24] rounded-t-2xl shadow-2xl border-t border-transparent dark:border-white/[0.08] flex flex-col overflow-hidden pb-safe"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Drag Handle */}
        <div className="pt-2.5 pb-1 flex justify-center shrink-0">
          <div className="w-10 h-1 rounded-full bg-surface-container-highest dark:bg-slate-600" />
        </div>

        {/* Sheet Header */}
        <div className="px-5 pt-2 pb-3 border-b border-surface-container-high/50 dark:border-white/[0.07] flex items-start justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-primary-fixed/60 dark:bg-primary/20 text-primary dark:text-[#ff9c85] text-label-sm font-label-sm font-semibold">
                <span className="material-symbols-outlined text-[13px]">auto_awesome</span>
                AI 景點導覽
              </span>
              <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 tabular-nums">
                {item.start_time} ・ {formatStayDuration(item.duration_minutes)}
              </span>
            </div>
            <h2 className="font-headline-md text-headline-md text-on-surface dark:text-white leading-snug break-words">
              {item.name}
            </h2>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {activeTab === 'chat' && itemMessages.length > 0 && (
              <button
                type="button"
                onClick={handleClearChat}
                disabled={chatSending}
                title="清除對話"
                aria-label="清除對話"
                className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[19px]">delete_sweep</span>
              </button>
            )}
            <button
              type="button"
              onClick={onCycleFontSize}
              title={`切換字體大小（目前：${fontSizeLabel}）`}
              aria-label={`切換字體大小，目前${fontSizeLabel}`}
              className="h-9 px-2.5 rounded-full inline-flex items-center gap-1 bg-surface-container-low dark:bg-[#24272E] border border-surface-container-high/70 dark:border-white/[0.08] text-on-surface-variant dark:text-slate-300 hover:bg-surface-container dark:hover:bg-[#2E323C] text-label-sm font-label-sm transition-colors active:scale-95"
            >
              <span className="material-symbols-outlined text-[16px]">format_size</span>
              <span>{fontSizeLabel}</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="關閉導覽視窗"
              className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        {/* Mode Tabs: 導覽內容 vs 景點 AI 對話 */}
        <div className="px-5 py-2 bg-surface-container-low/70 dark:bg-[#14171D] border-b border-surface-container-high/40 dark:border-white/[0.06] shrink-0">
          <div className="grid grid-cols-2 gap-1.5 p-1 rounded-xl bg-surface-container dark:bg-[#22252D]">
            <button
              type="button"
              onClick={() => setActiveTab('guide')}
              className={`h-8 rounded-lg text-label-md font-label-md inline-flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'guide'
                  ? 'bg-surface-container-lowest dark:bg-[#1A1D24] text-on-surface dark:text-white shadow-sm'
                  : 'text-on-surface-variant dark:text-slate-400 hover:text-on-surface dark:hover:text-slate-200'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">menu_book</span>
              <span>導覽與語音</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('chat')}
              className={`h-8 rounded-lg text-label-md font-label-md inline-flex items-center justify-center gap-1.5 transition-all ${
                activeTab === 'chat'
                  ? 'bg-surface-container-lowest dark:bg-[#1A1D24] text-primary dark:text-[#ff9c85] shadow-sm'
                  : 'text-on-surface-variant dark:text-slate-400 hover:text-on-surface dark:hover:text-slate-200'
              }`}
            >
              <span className="material-symbols-outlined text-[16px]">forum</span>
              <span>景點 AI 對話</span>
              {itemMessages.length > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-primary-container" />
              )}
            </button>
          </div>
        </div>

        {activeTab === 'chat' ? (
          <ChatPanel
            messages={itemMessages}
            sending={chatSending}
            error={chatError}
            emptyTitle={`想更了解「${item.name}」嗎？`}
            emptySubtitle="可以直接針對這個景點發問：附近美食、拍照機位、停留時間建議或雨天備案。"
            starterPrompts={ITEM_STARTER_PROMPTS}
            placeholder={`針對 ${item.name} 提問...`}
            webSearchAvailable={webSearchAvailable}
            webSearchEnabled={webSearchEnabled}
            onToggleWebSearch={() => setWebSearchEnabled((prev) => !prev)}
            onSend={(text) => void handleSendChat(text)}
          />
        ) : (
          <>
            {/* Style Switcher Pills */}
            <div className="px-5 py-2.5 bg-surface-container-low/50 dark:bg-[#14171D] border-b border-surface-container-high/40 dark:border-white/[0.05] flex items-center gap-2 overflow-x-auto no-scrollbar shrink-0">
          {STYLE_OPTIONS.map((opt) => {
            const active = style === opt.id;
            const isCached = item.cached_styles.includes(opt.id);
            return (
              <button
                key={opt.id}
                type="button"
                onClick={() => setStyle(opt.id)}
                className={`shrink-0 h-8 px-3 rounded-full text-label-md font-label-md inline-flex items-center gap-1.5 transition-all active:scale-95 ${
                  active
                    ? 'bg-primary-container text-on-primary shadow-sm'
                    : 'bg-surface-container-lowest dark:bg-[#24272E] text-on-surface-variant dark:text-slate-300 border border-surface-container-high/70 dark:border-white/[0.08] hover:bg-surface-container dark:hover:bg-[#2E323C]'
                }`}
              >
                <span className="material-symbols-outlined text-[15px]">{opt.icon}</span>
                <span>{opt.label}</span>
                {isCached && !active && (
                  <span
                    title="已快取"
                    className="w-1.5 h-1.5 rounded-full bg-tertiary dark:bg-emerald-400"
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Scrollable Content Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {error && (
            <div className="rounded-xl bg-error-container/80 dark:bg-rose-950/60 border border-error/20 dark:border-rose-500/30 p-3.5 text-on-error-container dark:text-rose-200 text-body-sm flex flex-col gap-2">
              <div className="flex items-start gap-2">
                <span className="material-symbols-outlined text-[18px] shrink-0 mt-0.5">
                  error
                </span>
                <p className="leading-relaxed">{error}</p>
              </div>
              {!guide && (
                <button
                  type="button"
                  onClick={() => setReloadNonce((n) => n + 1)}
                  className="self-start px-3 py-1 rounded-full bg-surface-container-lowest dark:bg-[#262c36] text-on-surface dark:text-white text-label-md font-label-md shadow-xs"
                >
                  重新嘗試
                </button>
              )}
            </div>
          )}

          {loadingText ? (
            <div className="flex flex-col gap-3 py-2 animate-pulse">
              <div className="flex items-center gap-2 text-primary dark:text-[#ff9c85] text-body-sm font-medium">
                <span className="material-symbols-outlined text-[18px] animate-spin">
                  progress_activity
                </span>
                <span>Gemini 正在撰寫專屬導覽文案...</span>
              </div>
              <div className="h-4 w-1/3 rounded bg-surface-container-high dark:bg-[#2A2D35]" />
              <div className="h-24 w-full rounded-xl bg-surface-container-low dark:bg-[#22252D]" />
              <div className="h-4 w-1/4 rounded bg-surface-container-high dark:bg-[#2A2D35] mt-1" />
              <div className="h-16 w-full rounded-xl bg-surface-container-low dark:bg-[#22252D]" />
            </div>
          ) : guide ? (
            <>
              {/* Story Section */}
              <section className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h3 className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-white flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[18px] text-primary dark:text-[#ff9c85]">
                      menu_book
                    </span>
                    景點故事與背景
                  </h3>
                  <button
                    type="button"
                    onClick={handleRegenerateText}
                    disabled={loadingText || loadingAudio}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-label-sm font-label-sm text-on-surface-variant dark:text-slate-300 bg-surface-container-low dark:bg-[#24272E] hover:bg-surface-container dark:hover:bg-[#2E323C] transition-colors disabled:opacity-50"
                  >
                    <span className="material-symbols-outlined text-[14px]">refresh</span>
                    <span>重新生成文案</span>
                  </button>
                </div>
                <p className="text-body-md font-body-md text-on-surface-variant dark:text-slate-300 leading-relaxed bg-surface-container-low/60 dark:bg-[#22252D] rounded-xl p-3.5">
                  <LinkifiedText text={guide.story} />
                </p>
              </section>

              {/* Highlights Section */}
              {guide.highlights.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-white flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[18px] text-secondary dark:text-sky-400">
                      stars
                    </span>
                    必看亮點
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {guide.highlights.map((hl, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2.5 text-body-sm font-body-sm text-on-surface dark:text-slate-200 bg-secondary-fixed/30 dark:bg-sky-950/30 border border-secondary-fixed/60 dark:border-sky-500/20 rounded-xl px-3.5 py-2.5 leading-relaxed"
                      >
                        <span className="w-5 h-5 rounded-full bg-secondary/15 dark:bg-sky-500/20 text-secondary dark:text-sky-300 text-label-sm font-bold flex items-center justify-center shrink-0 mt-0.5">
                          {idx + 1}
                        </span>
                        <span>
                          <LinkifiedText text={hl} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Local Tips Section */}
              {guide.tips.length > 0 && (
                <section className="flex flex-col gap-2">
                  <h3 className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-white flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-[18px] text-tertiary dark:text-emerald-400">
                      tips_and_updates
                    </span>
                    在地實用建議
                  </h3>
                  <ul className="flex flex-col gap-2">
                    {guide.tips.map((tip, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-2 text-body-sm font-body-sm text-on-surface-variant dark:text-slate-300 bg-tertiary-fixed/25 dark:bg-emerald-950/30 border border-tertiary-fixed-dim/40 dark:border-emerald-500/20 rounded-xl px-3.5 py-2.5 leading-relaxed"
                      >
                        <span className="material-symbols-outlined text-[16px] text-tertiary dark:text-emerald-400 shrink-0 mt-0.5">
                          check_circle
                        </span>
                        <span>
                          <LinkifiedText text={tip} />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Web Sources Section */}
              {(() => {
                const safeSources = filterSafeWebSources(guide.sources);
                if (safeSources.length === 0) return null;
                return (
                  <section className="flex flex-col gap-2">
                    <h3 className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-white flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="material-symbols-outlined text-[18px] text-secondary dark:text-sky-400 select-none"
                      >
                        public
                      </span>
                      網路參考來源
                    </h3>
                    <ul className="flex flex-col gap-1.5">
                      {safeSources.map((src, idx) => {
                        const host = getSourceHost(src.url);
                        return (
                          <li key={`${src.url}-${idx}`}>
                            <a
                              href={src.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              title={src.url}
                              className="flex items-center justify-between gap-2 px-3.5 py-2.5 rounded-xl bg-surface-container-low/70 dark:bg-[#22252D] border border-surface-container-high/60 dark:border-white/[0.06] hover:bg-surface-container dark:hover:bg-[#2A2E38] text-body-sm font-body-sm text-secondary dark:text-sky-300 transition-colors"
                            >
                              <div className="min-w-0 flex flex-col">
                                <span className="truncate">{src.title || host || src.url}</span>
                                {host && (
                                  <span className="text-label-sm font-label-sm text-on-surface-variant/75 dark:text-slate-400 truncate">
                                    {host}
                                  </span>
                                )}
                              </div>
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[16px] shrink-0 select-none"
                              >
                                open_in_new
                              </span>
                            </a>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                );
              })()}
            </>
          ) : null}
        </div>

        {/* Sticky Audio Footer */}
        {guide && !loadingText && (
          <div className="px-5 py-3.5 bg-surface-container-low/90 dark:bg-[#14171D] border-t border-surface-container-high/60 dark:border-white/[0.08] shrink-0">
            {!guide.audio_url ? (
              <button
                type="button"
                onClick={() => handleGenerateAudio(false)}
                disabled={loadingAudio}
                className="w-full h-12 rounded-xl bg-primary-container text-on-primary font-headline-sm text-body-md font-semibold flex items-center justify-center gap-2 shadow-md hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-60"
              >
                {loadingAudio ? (
                  <>
                    <span className="material-symbols-outlined text-[19px] animate-spin">
                      progress_activity
                    </span>
                    <span>正在生成 Gemini 語音導覽...</span>
                  </>
                ) : (
                  <>
                    <span className="material-symbols-outlined text-[20px]">graphic_eq</span>
                    <span>生成語音導覽</span>
                  </>
                )}
              </button>
            ) : (
              <div className="flex flex-col gap-2">
                <audio
                  ref={audioRef}
                  key={guide.audio_url}
                  src={guide.audio_url}
                  preload="metadata"
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onEnded={() => setIsPlaying(false)}
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  onLoadedMetadata={(e) => {
                    setDuration(e.currentTarget.duration || 0);
                    e.currentTarget.playbackRate = PLAYBACK_RATES[rateIndex];
                  }}
                />
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={togglePlay}
                    aria-label={isPlaying ? '暫停導覽語音' : '播放導覽語音'}
                    className="w-11 h-11 rounded-full bg-primary-container text-on-primary flex items-center justify-center shadow-md hover:opacity-95 active:scale-95 transition-all shrink-0"
                  >
                    <span className="material-symbols-outlined text-[24px]">
                      {isPlaying ? 'pause' : 'play_arrow'}
                    </span>
                  </button>

                  <div className="flex-1 min-w-0 flex flex-col gap-1">
                    <input
                      type="range"
                      min={0}
                      max={duration || 0}
                      step={0.1}
                      value={Math.min(currentTime, duration || 0)}
                      onChange={handleSeek}
                      aria-label="播放進度"
                      className="w-full accent-[#ff6b4a] h-1.5 rounded-lg cursor-pointer"
                    />
                    <div className="flex items-center justify-between text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 tabular-nums">
                      <span>{formatAudioSeconds(currentTime)}</span>
                      <span>{formatAudioSeconds(duration)}</span>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={cycleRate}
                    title="切換語速"
                    className="h-8 px-2.5 rounded-full bg-surface-container-lowest dark:bg-[#24272E] border border-surface-container-high dark:border-white/[0.08] text-label-sm font-label-sm font-semibold text-on-surface dark:text-slate-200 tabular-nums shrink-0"
                  >
                    {PLAYBACK_RATES[rateIndex]}x
                  </button>

                  <button
                    type="button"
                    onClick={() => handleGenerateAudio(true)}
                    disabled={loadingAudio}
                    title="重新生成語音"
                    aria-label="重新生成語音"
                    className="w-8 h-8 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors shrink-0 disabled:opacity-50"
                  >
                    <span
                      className={`material-symbols-outlined text-[18px] ${
                        loadingAudio ? 'animate-spin' : ''
                      }`}
                    >
                      {loadingAudio ? 'progress_activity' : 'refresh'}
                    </span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
          </>
        )}
      </div>
    </div>
  );
};
