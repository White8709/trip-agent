import React, { useEffect, useState } from 'react';
import { ChatMessage, chatWithDay, TripDay } from '../lib/api';
import { formatDateWithWeekday } from '../lib/parser';
import { ChatPanel } from './ChatPanel';

interface DayChatSheetProps {
  isOpen: boolean;
  tripId: string;
  tripTitle: string;
  day: TripDay | null;
  onClose: () => void;
}

const DAY_STARTER_PROMPTS = [
  '這天行程順嗎？有什麼動線建議？',
  '幫我推薦這天景點附近的必吃美食',
  '這天有哪些時間安排或注意事項？',
];

export const DayChatSheet: React.FC<DayChatSheetProps> = ({
  isOpen,
  tripId,
  tripTitle,
  day,
  onClose,
}) => {
  const [historyByDay, setHistoryByDay] = useState<Record<number, ChatMessage[]>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHistoryByDay({});
    setError(null);
  }, [tripId]);

  useEffect(() => {
    setError(null);
  }, [day?.day_number]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || !day) return null;

  const dayNumber = day.day_number;
  const messages = historyByDay[dayNumber] ?? [];

  const handleSend = async (text: string) => {
    if (sending) return;
    const userMsg: ChatMessage = { role: 'user', content: text };
    const nextMessages = [...messages, userMsg];

    setHistoryByDay((prev) => ({
      ...prev,
      [dayNumber]: nextMessages,
    }));
    setSending(true);
    setError(null);

    try {
      const reply = await chatWithDay(tripId, dayNumber, nextMessages);
      setHistoryByDay((prev) => ({
        ...prev,
        [dayNumber]: [...(prev[dayNumber] ?? nextMessages), { role: 'model', content: reply }],
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AI 回覆失敗，請稍後再試。');
    } finally {
      setSending(false);
    }
  };

  const handleClear = () => {
    setHistoryByDay((prev) => {
      const next = { ...prev };
      delete next[dayNumber];
      return next;
    });
    setError(null);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[#1A202C]/35 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="animate-sheet-up w-full max-w-[430px] h-[82dvh] bg-surface-container-lowest dark:bg-[#1A1D24] rounded-t-2xl shadow-2xl border-t border-transparent dark:border-white/[0.08] flex flex-col overflow-hidden pb-safe"
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
                當天 AI 行程助手
              </span>
              <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 truncate">
                {tripTitle}
              </span>
            </div>
            <h2 className="font-headline-md text-headline-md text-on-surface dark:text-white leading-snug">
              第 {day.day_number} 天 ・ {formatDateWithWeekday(day.date)}
            </h2>
          </div>

          <div className="flex items-center gap-1 shrink-0">
            {messages.length > 0 && (
              <button
                type="button"
                onClick={handleClear}
                disabled={sending}
                title="清除對話"
                aria-label="清除對話"
                className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors disabled:opacity-50"
              >
                <span className="material-symbols-outlined text-[19px]">delete_sweep</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="關閉 AI 行程助手"
              className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors"
            >
              <span className="material-symbols-outlined text-[20px]">close</span>
            </button>
          </div>
        </div>

        {/* Active Day Stops Context Bar */}
        <div className="px-5 py-2 bg-surface-container-low/60 dark:bg-[#14171D] border-b border-surface-container-high/40 dark:border-white/[0.05] flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0">
          <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 shrink-0 mr-1">
            當日 {day.items.length} 站：
          </span>
          {day.items.map((item) => (
            <span
              key={item.item_id}
              className="shrink-0 px-2.5 py-1 rounded-full bg-surface-container-lowest dark:bg-[#24272E] border border-surface-container-high/60 dark:border-white/[0.08] text-label-sm font-label-sm text-on-surface dark:text-slate-300 tabular-nums"
            >
              {item.start_time} {item.name}
            </span>
          ))}
        </div>

        <ChatPanel
          messages={messages}
          sending={sending}
          error={error}
          emptyTitle={`已載入第 ${day.day_number} 天完整行程`}
          emptySubtitle="可以問我這天的動線順不順、景點間建議怎麼移動、附近必吃美食或備案調整！"
          starterPrompts={DAY_STARTER_PROMPTS}
          placeholder={`詢問第 ${day.day_number} 天行程問題...`}
          onSend={(text) => void handleSend(text)}
        />
      </div>
    </div>
  );
};
