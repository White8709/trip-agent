import React, { useEffect, useState } from 'react';
import { DayChatSheet } from '../components/DayChatSheet';
import { Trip, TripItem } from '../lib/api';
import {
  formatDateWithWeekday,
  formatShortMonthDay,
  formatStayDuration,
  formatTotalStay,
} from '../lib/parser';

interface TimelinePageProps {
  trip: Trip;
  isDark: boolean;
  webSearchAvailable: boolean;
  onToggleTheme: () => void;
  onOpenDeviceModal: () => void;
  onSelectGuide: (item: TripItem) => void;
}

export const TimelinePage: React.FC<TimelinePageProps> = ({
  trip,
  isDark,
  webSearchAvailable,
  onToggleTheme,
  onOpenDeviceModal,
  onSelectGuide,
}) => {
  const [selectedDayNumber, setSelectedDayNumber] = useState<number>(
    trip.days[0]?.day_number ?? 1,
  );
  const [dayChatOpen, setDayChatOpen] = useState(false);

  useEffect(() => {
    setSelectedDayNumber(trip.days[0]?.day_number ?? 1);
    setDayChatOpen(false);
  }, [trip.id]);

  const currentDay =
    trip.days.find((d) => d.day_number === selectedDayNumber) ?? trip.days[0];

  const dayStayMinutes = currentDay
    ? currentDay.items.reduce((acc, item) => acc + item.duration_minutes, 0)
    : 0;

  return (
    <div className="min-h-screen flex flex-col bg-surface dark:bg-[#121316] text-on-surface dark:text-[#E2E8F0] transition-colors duration-200">
      {/* Fixed Header */}
      <header className="fixed top-0 inset-x-0 z-40 pt-safe bg-surface/85 dark:bg-[#121316]/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_8px_rgba(0,0,0,0.4)] dark:border-b dark:border-white/[0.08] transition-colors duration-200">
        <div className="h-16 px-margin max-w-[430px] mx-auto w-full flex items-center justify-between gap-2">
          <div className="w-9 h-9 rounded-full bg-primary-fixed/60 dark:bg-primary/20 flex items-center justify-center shrink-0">
            <span className="material-symbols-outlined text-primary dark:text-[#ff9c85] text-[20px]">
              auto_stories
            </span>
          </div>

          <div className="flex-1 min-w-0 flex justify-center px-1">
            <h1 className="font-headline-md text-headline-md text-on-surface dark:text-white tracking-tight truncate select-none">
              {trip.title}
            </h1>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label="切換深淺模式"
              className="w-9 h-9 flex items-center justify-center rounded-full text-on-surface dark:text-amber-300 hover:bg-surface-container dark:hover:bg-[#24272E] active:scale-95 transition-all duration-200"
            >
              <span className="material-symbols-outlined text-[20px]">
                {isDark ? 'light_mode' : 'dark_mode'}
              </span>
            </button>

            {trip.share_url && (
              <a
                href={trip.share_url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="開啟去趣原行程"
                className="inline-flex items-center gap-1 h-9 px-2.5 rounded-full bg-surface-container-low dark:bg-[#24272E] hover:bg-surface-container dark:hover:bg-[#2A2D35] active:scale-95 text-secondary dark:text-sky-400 transition-colors"
              >
                <span className="font-label-md text-label-md">原行程</span>
                <span className="material-symbols-outlined text-[15px]">open_in_new</span>
              </a>
            )}

            <button
              type="button"
              onClick={onOpenDeviceModal}
              aria-label="裝置識別與同步"
              className="w-8 h-8 rounded-full bg-primary dark:bg-[#FF6B4A] flex items-center justify-center shrink-0 shadow-sm active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative w-full max-w-[430px] mx-auto pt-16 pb-24">
        {/* Sticky Day Selector Bar */}
        <section className="sticky top-16 z-30 bg-surface/90 dark:bg-[#121316]/90 backdrop-blur-md px-margin py-space-sm shadow-sm transition-colors duration-200">
          <div className="flex items-center gap-space-sm overflow-x-auto no-scrollbar py-0.5">
            {trip.days.map((day) => {
              const isActive = day.day_number === currentDay?.day_number;
              return (
                <button
                  key={day.day_number}
                  type="button"
                  onClick={() => setSelectedDayNumber(day.day_number)}
                  className={`shrink-0 px-4 py-2 rounded-full font-label-md text-label-md shadow-sm transition-all duration-150 active:scale-95 flex items-center gap-1.5 ${
                    isActive
                      ? 'bg-primary-container text-on-primary'
                      : 'bg-surface-container-lowest dark:bg-[#24272E] text-on-surface-variant dark:text-slate-300 dark:border dark:border-white/[0.08] hover:bg-surface-container dark:hover:bg-[#2A2D35]'
                  }`}
                >
                  {isActive && <span className="w-1.5 h-1.5 rounded-full bg-on-primary" />}
                  <span>
                    第{day.day_number}天 {formatShortMonthDay(day.date)}
                  </span>
                </button>
              );
            })}
          </div>

          {/* Day Summary Header Card (Strictly Spec-Derived) */}
          {currentDay && (
            <div className="mt-space-sm px-space-md py-2.5 rounded-xl bg-surface-container-lowest dark:bg-[#1E2026] dark:border dark:border-white/[0.08] shadow-sm flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-surface-container dark:bg-[#2A2D35] flex items-center justify-center shrink-0">
                  <span className="material-symbols-outlined text-primary dark:text-[#ff8a70] text-[18px]">
                    calendar_today
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="font-headline-sm text-headline-sm text-on-surface dark:text-white truncate">
                    {formatDateWithWeekday(currentDay.date)}
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant dark:text-slate-400 truncate">
                    第 {currentDay.day_number} 天 ・ {currentDay.items.length} 個行程景點
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 text-tertiary dark:text-emerald-400 bg-tertiary-container/15 dark:bg-emerald-950/40 dark:border dark:border-emerald-500/20 px-2.5 py-1 rounded-full shrink-0">
                <span className="material-symbols-outlined text-[14px]">schedule</span>
                <span className="font-label-sm text-label-sm font-semibold">
                  {formatTotalStay(dayStayMinutes)}
                </span>
              </div>
            </div>
          )}
        </section>

        {/* Vertical Timeline Section */}
        {currentDay && (
          <section className="px-margin pt-space-md">
            <div className="relative">
              {/* Continuous Background Track Line */}
              <div className="absolute left-[38px] top-6 bottom-8 w-[2px] bg-surface-container-highest dark:bg-slate-700/60 rounded-full pointer-events-none" />

              {currentDay.items.map((item, idx) => {
                const isZeroStay = item.duration_minutes === 0;
                const prevSameTime =
                  idx > 0 && currentDay.items[idx - 1].start_time === item.start_time;
                const hasCachedGuide = item.cached_styles.length > 0;

                return (
                  <article
                    key={item.item_id}
                    className="relative flex items-start gap-3.5 mb-5 group"
                  >
                    {/* Left Time Pillar */}
                    <div className="w-14 shrink-0 pt-3 flex flex-col items-center">
                      <span
                        className={`font-headline-sm text-headline-sm font-semibold tracking-tight tabular-nums ${
                          isZeroStay
                            ? 'text-outline dark:text-slate-400'
                            : idx === 0
                              ? 'text-primary dark:text-[#ff8a70]'
                              : 'text-on-surface dark:text-slate-200'
                        }`}
                      >
                        {item.start_time}
                      </span>

                      {isZeroStay ? (
                        <div className="relative z-10 mt-2 w-4 h-4 rounded-full bg-surface-container-lowest dark:bg-[#1E2026] flex items-center justify-center shadow-xs border border-surface-container-highest dark:border-slate-600">
                          <div className="w-2 h-2 rounded-full bg-surface-container-highest dark:bg-slate-600" />
                        </div>
                      ) : (
                        <div
                          className={`relative z-10 mt-2 rounded-full flex items-center justify-center shadow-sm ${
                            idx === 0
                              ? 'w-5 h-5 bg-primary-container'
                              : 'w-4 h-4 bg-primary-container/85'
                          }`}
                        >
                          <div className="w-2 h-2 rounded-full bg-surface-container-lowest dark:bg-[#121316]" />
                        </div>
                      )}
                    </div>

                    {/* Stop Card */}
                    <div
                      className={`flex-1 min-w-0 rounded-xl p-space-md transition-transform ${
                        isZeroStay
                          ? 'bg-surface-container-low dark:bg-[#1A1D24] dark:border dark:border-white/[0.06] shadow-xs'
                          : 'bg-surface-container-lowest dark:bg-[#1E2026] dark:border dark:border-white/[0.08] shadow-sm'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                          <span className="px-2 py-0.5 rounded-full bg-surface-container dark:bg-[#2A2D35] text-on-surface-variant dark:text-slate-300 font-label-sm text-label-sm tabular-nums shrink-0">
                            #{item.sequence}
                          </span>
                          {prevSameTime && (
                            <span className="px-2 py-0.5 rounded-full bg-primary-fixed/60 dark:bg-primary/20 text-on-primary-fixed-variant dark:text-[#ffb4a3] font-label-sm text-label-sm inline-flex items-center gap-1 shrink-0">
                              <span className="material-symbols-outlined text-[12px]">
                                alt_route
                              </span>
                              同時間段
                            </span>
                          )}
                        </div>

                        <span
                          className={`px-2 py-0.5 rounded-md font-label-sm text-label-sm shrink-0 ${
                            isZeroStay
                              ? 'bg-surface-container-highest dark:bg-[#2A2D35] text-outline dark:text-slate-400'
                              : 'bg-surface-container-low dark:bg-[#2A2D35] text-on-surface-variant dark:text-slate-300'
                          }`}
                        >
                          {formatStayDuration(item.duration_minutes)}
                        </span>
                      </div>

                      <h2 className="font-headline-sm text-headline-sm text-on-surface dark:text-white font-semibold break-words mb-3">
                        {item.name}
                      </h2>

                      <div className="flex items-center justify-between gap-2">
                        <button
                          type="button"
                          onClick={() => onSelectGuide(item)}
                          className="inline-flex items-center gap-1.5 text-primary dark:text-[#ff9c85] bg-primary-fixed/45 dark:bg-primary/20 hover:bg-primary-fixed dark:hover:bg-primary/30 font-label-md text-label-md px-3 py-1.5 rounded-full transition-colors active:scale-95"
                        >
                          <span className="material-symbols-outlined text-[15px]">
                            auto_awesome
                          </span>
                          <span>AI 導覽</span>
                          {hasCachedGuide && (
                            <span
                              title="已有導覽快取"
                              className="w-1.5 h-1.5 rounded-full bg-tertiary dark:bg-emerald-400 ml-0.5"
                            />
                          )}
                        </button>

                        {hasCachedGuide && (
                          <span className="text-label-sm font-label-sm text-tertiary dark:text-emerald-400 flex items-center gap-1">
                            <span className="material-symbols-outlined text-[14px]">
                              check_circle
                            </span>
                            已備妥導覽
                          </span>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        )}
      </main>

      {/* Floating Action Button (Day AI Chat) */}
      <aside className="fixed bottom-6 right-6 z-40 flex items-center gap-2 pb-safe">
        <div className="hidden sm:flex px-3 py-1.5 rounded-full bg-inverse-surface/90 dark:bg-black/90 text-inverse-on-surface dark:text-white font-label-md text-label-md shadow-md backdrop-blur-sm pointer-events-none">
          AI 行程助手
        </div>
        <button
          type="button"
          onClick={() => setDayChatOpen(true)}
          aria-label="開啟當天 AI 行程助手"
          title="當天 AI 行程助手"
          className="w-14 h-14 rounded-full bg-primary-container text-on-primary flex items-center justify-center shadow-lg hover:shadow-xl active:scale-95 transition-all duration-200"
        >
          <span className="material-symbols-outlined text-[26px]">auto_awesome</span>
        </button>
      </aside>

      <DayChatSheet
        isOpen={dayChatOpen}
        tripId={trip.id}
        tripTitle={trip.title}
        day={currentDay ?? null}
        webSearchAvailable={webSearchAvailable}
        onClose={() => setDayChatOpen(false)}
      />
    </div>
  );
};
