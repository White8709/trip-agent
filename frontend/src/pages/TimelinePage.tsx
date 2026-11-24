import React, { useEffect, useRef, useState } from 'react';
import { DayChatSheet } from '../components/DayChatSheet';
import { Trip, TripItem, TripSummary } from '../lib/api';
import {
  formatDateWithWeekday,
  formatShortMonthDay,
  formatStayDuration,
  formatTotalStay,
} from '../lib/parser';

interface TimelinePageProps {
  trip: Trip;
  trips: TripSummary[];
  switchingTrip?: boolean;
  onOpenTripList: () => void;
  onSwitchTrip: (tripId: string) => void;
  onOpenImportNew: () => void;
  isDark: boolean;
  webSearchAvailable: boolean;
  activeGuideItemId?: number | null;
  renderGuidePanel?: (currentDayItems: TripItem[]) => React.ReactNode;
  onToggleTheme: () => void;
  onOpenDeviceModal: () => void;
  onSelectGuide: (item: TripItem) => void;
}

export const TimelinePage: React.FC<TimelinePageProps> = ({
  trip,
  trips,
  switchingTrip = false,
  onOpenTripList,
  onSwitchTrip,
  onOpenImportNew,
  isDark,
  webSearchAvailable,
  activeGuideItemId = null,
  renderGuidePanel,
  onToggleTheme,
  onOpenDeviceModal,
  onSelectGuide,
}) => {
  const [selectedDayNumber, setSelectedDayNumber] = useState<number>(
    trip.days[0]?.day_number ?? 1,
  );
  const [dayChatOpen, setDayChatOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherRef = useRef<HTMLDivElement | null>(null);
  const canSwitch = trips.length > 1;

  useEffect(() => {
    setSwitcherOpen(false);
  }, [trip.id]);

  useEffect(() => {
    if (!switcherOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSwitcherOpen(false);
    };
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      if (switcherRef.current && !switcherRef.current.contains(e.target as Node)) {
        setSwitcherOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
    };
  }, [switcherOpen]);

  useEffect(() => {
    setSelectedDayNumber(trip.days[0]?.day_number ?? 1);
    setDayChatOpen(false);
  }, [trip.id]);

  const currentDay =
    trip.days.find((d) => d.day_number === selectedDayNumber) ?? trip.days[0];

  const dayStayMinutes = currentDay
    ? currentDay.items.reduce((acc, item) => acc + item.duration_minutes, 0)
    : 0;
  const totalStops = trip.days.reduce((acc, day) => acc + day.items.length, 0);

  return (
    <div className="min-h-screen flex flex-col bg-surface dark:bg-[#121316] text-on-surface dark:text-[#E2E8F0] transition-colors duration-200">
      {/* Fixed Header */}
      <header className="fixed top-0 inset-x-0 z-40 pt-safe bg-surface/85 dark:bg-[#121316]/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_8px_rgba(0,0,0,0.4)] dark:border-b dark:border-white/[0.08] transition-colors duration-200">
        <div className="h-16 px-margin md:px-margin-desktop max-w-[720px] lg:max-w-[1140px] xl:max-w-[1440px] mx-auto w-full flex items-center justify-between gap-2 lg:gap-4">
          <button
            type="button"
            onClick={onOpenTripList}
            aria-label="回到我的行程"
            title="我的行程"
            className="w-9 h-9 rounded-full bg-primary-fixed/60 dark:bg-primary/20 hover:bg-primary-fixed dark:hover:bg-primary/30 flex items-center justify-center shrink-0 active:scale-95 transition-all"
          >
            <span className="material-symbols-outlined text-primary dark:text-[#ff9c85] text-[18px]">
              arrow_back_ios_new
            </span>
          </button>

          <div className="flex-1 min-w-0 flex justify-center lg:justify-start items-center gap-2.5 px-1">
            <div ref={switcherRef} className="relative min-w-0">
              {canSwitch ? (
                <button
                  type="button"
                  onClick={() => setSwitcherOpen((v) => !v)}
                  aria-haspopup="listbox"
                  aria-expanded={switcherOpen}
                  aria-label="切換行程"
                  title="切換行程"
                  className="max-w-full inline-flex items-center gap-1 rounded-lg px-1.5 -mx-1.5 py-1 hover:bg-surface-container-low dark:hover:bg-[#24272E] active:scale-[0.99] transition-colors"
                >
                  <h1 className="font-headline-md text-headline-md text-on-surface dark:text-white tracking-tight truncate select-none">
                    {trip.title}
                  </h1>
                  <span
                    className={`material-symbols-outlined text-[20px] text-on-surface-variant dark:text-slate-400 shrink-0 transition-transform ${
                      switcherOpen ? 'rotate-180' : ''
                    }`}
                  >
                    expand_more
                  </span>
                </button>
              ) : (
                <h1 className="font-headline-md text-headline-md text-on-surface dark:text-white tracking-tight truncate select-none">
                  {trip.title}
                </h1>
              )}

              {canSwitch && switcherOpen && (
                <div
                  role="listbox"
                  className="absolute left-1/2 -translate-x-1/2 lg:left-0 lg:translate-x-0 top-full mt-2 w-[min(320px,calc(100vw-32px))] max-h-[60vh] overflow-y-auto rounded-2xl bg-surface-container-lowest dark:bg-[#1c1f26] shadow-xl border border-surface-container-high/60 dark:border-white/[0.1] p-1.5 z-50 flex flex-col gap-0.5"
                >
                  {trips.map((t) => {
                    const isCurrent = t.id === trip.id;
                    return (
                      <button
                        key={t.id}
                        type="button"
                        role="option"
                        aria-selected={isCurrent}
                        disabled={switchingTrip}
                        onClick={() => {
                          setSwitcherOpen(false);
                          if (!isCurrent) onSwitchTrip(t.id);
                        }}
                        className={`w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-colors disabled:opacity-60 ${
                          isCurrent
                            ? 'bg-primary-fixed/50 dark:bg-primary/20 text-primary dark:text-[#ff9c85]'
                            : 'text-on-surface dark:text-slate-200 hover:bg-surface-container-low dark:hover:bg-[#24272E]'
                        }`}
                      >
                        <span className="flex-1 min-w-0 flex flex-col">
                          <span className="text-body-sm font-body-sm font-semibold truncate">
                            {t.title}
                          </span>
                          <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400 truncate tabular-nums">
                            {t.start_date
                              ? t.start_date === t.end_date || !t.end_date
                                ? t.start_date
                                : `${t.start_date} ~ ${t.end_date}`
                              : `${t.day_count} 天 ・ ${t.item_count} 個景點`}
                          </span>
                        </span>
                        {isCurrent && (
                          <span className="material-symbols-outlined text-[18px] shrink-0">check</span>
                        )}
                      </button>
                    );
                  })}
                  <div className="border-t border-surface-container-high/60 dark:border-white/[0.08] my-1" />
                  <button
                    type="button"
                    onClick={() => {
                      setSwitcherOpen(false);
                      onOpenTripList();
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 text-body-sm font-body-sm text-on-surface dark:text-slate-200 hover:bg-surface-container-low dark:hover:bg-[#24272E] transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px] text-secondary dark:text-sky-400">
                      luggage
                    </span>
                    <span>查看全部行程</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSwitcherOpen(false);
                      onOpenImportNew();
                    }}
                    className="w-full text-left px-3 py-2 rounded-xl flex items-center gap-2 text-body-sm font-body-sm text-on-surface dark:text-slate-200 hover:bg-surface-container-low dark:hover:bg-[#24272E] transition-colors"
                  >
                    <span className="material-symbols-outlined text-[18px] text-primary dark:text-[#ff9c85]">
                      add_circle
                    </span>
                    <span>匯入新行程</span>
                  </button>
                </div>
              )}
            </div>
            <span className="hidden md:inline-flex items-center px-2.5 py-0.5 rounded-full bg-surface-container-low dark:bg-[#24272E] text-label-sm font-label-sm text-on-surface-variant dark:text-slate-300 shrink-0 tabular-nums">
              共 {trip.days.length} 天 ・ {totalStops} 個景點
            </span>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label="切換深淺模式"
              title="切換深淺模式"
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
                title="開啟去趣原行程"
                className="inline-flex items-center gap-1 h-9 px-2.5 rounded-full bg-surface-container-low dark:bg-[#24272E] hover:bg-surface-container dark:hover:bg-[#2A2D35] active:scale-95 text-secondary dark:text-sky-400 transition-colors"
              >
                <span className="hidden min-[360px]:inline font-label-md text-label-md">
                  原行程
                </span>
                <span className="material-symbols-outlined text-[15px]">open_in_new</span>
              </a>
            )}

            <button
              type="button"
              onClick={onOpenDeviceModal}
              aria-label="裝置識別與同步"
              title="裝置識別與同步"
              className="w-8 h-8 rounded-full bg-primary dark:bg-[#FF6B4A] flex items-center justify-center shrink-0 shadow-sm active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative w-full max-w-[720px] lg:max-w-[1140px] xl:max-w-[1440px] mx-auto pt-16 pb-24 lg:pb-10">
        {/* Mobile & Tablet Sticky Day Selector Bar */}
        <section className="lg:hidden sticky top-16 z-30 bg-surface/90 dark:bg-[#121316]/90 backdrop-blur-md px-margin md:px-margin-desktop py-space-sm shadow-sm transition-colors duration-200">
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

        {/* Desktop Multi-Column Area + Mobile Vertical Timeline */}
        <div className="lg:flex lg:items-start lg:gap-6 lg:px-margin-desktop lg:pt-6">
          {/* Desktop Left Sticky Day Sidebar */}
          {currentDay && (
            <aside className="hidden lg:flex lg:flex-col lg:w-[260px] xl:w-[240px] 2xl:w-[264px] shrink-0 lg:sticky lg:top-[84px] gap-4">
              <div className="p-4 rounded-2xl bg-surface-container-lowest dark:bg-[#1E2026] border border-surface-container-high/60 dark:border-white/[0.08] shadow-sm flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-xl bg-surface-container dark:bg-[#2A2D35] flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-primary dark:text-[#ff8a70] text-[19px]">
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

                  <button
                    type="button"
                    onClick={() => setDayChatOpen(true)}
                    aria-label="開啟當天 AI 行程助手"
                    title="當天 AI 行程助手"
                    className="hidden xl:inline-flex w-9 h-9 rounded-full bg-primary-container text-on-primary items-center justify-center shadow-sm hover:opacity-95 active:scale-95 transition-all shrink-0"
                  >
                    <span
                      aria-hidden="true"
                      className="material-symbols-outlined text-[18px] select-none"
                    >
                      auto_awesome
                    </span>
                  </button>
                </div>

                <div className="inline-flex self-start items-center gap-1.5 text-tertiary dark:text-emerald-400 bg-tertiary-container/15 dark:bg-emerald-950/40 border border-transparent dark:border-emerald-500/20 px-2.5 py-1 rounded-full">
                  <span className="material-symbols-outlined text-[14px]">schedule</span>
                  <span className="font-label-sm text-label-sm font-semibold tabular-nums">
                    總停留 {formatTotalStay(dayStayMinutes)}
                  </span>
                </div>
              </div>

              <nav
                aria-label="行程天數切換"
                className="flex flex-col gap-1.5 max-h-[calc(100dvh-280px)] overflow-y-auto pr-1"
              >
                {trip.days.map((day) => {
                  const isActive = day.day_number === currentDay?.day_number;
                  return (
                    <button
                      key={day.day_number}
                      type="button"
                      onClick={() => setSelectedDayNumber(day.day_number)}
                      aria-current={isActive ? 'page' : undefined}
                      className={`w-full px-3.5 py-2.5 rounded-xl font-label-md text-label-md transition-all duration-150 active:scale-[0.99] flex items-center justify-between gap-2 text-left ${
                        isActive
                          ? 'bg-primary-container text-on-primary shadow-sm'
                          : 'bg-surface-container-lowest dark:bg-[#1E2026] text-on-surface-variant dark:text-slate-300 border border-surface-container-high/50 dark:border-white/[0.08] hover:bg-surface-container dark:hover:bg-[#2A2D35]'
                      }`}
                    >
                      <span className="inline-flex items-center gap-2 min-w-0">
                        {isActive && <span className="w-1.5 h-1.5 rounded-full bg-on-primary shrink-0" />}
                        <span className="truncate">
                          第{day.day_number}天 {formatShortMonthDay(day.date)}
                        </span>
                      </span>
                      <span
                        className={`text-label-sm font-label-sm tabular-nums shrink-0 px-2 py-0.5 rounded-full ${
                          isActive
                            ? 'bg-white/20 text-on-primary'
                            : 'bg-surface-container dark:bg-[#2A2D35] text-on-surface-variant dark:text-slate-400'
                        }`}
                      >
                        {day.items.length} 站
                      </span>
                    </button>
                  );
                })}
              </nav>
            </aside>
          )}

          {/* Center Vertical Timeline Section */}
          {currentDay && (
            <section className="px-margin md:px-margin-desktop lg:px-0 pt-space-md lg:pt-0 flex-1 min-w-0 lg:max-w-[760px] xl:max-w-none">
              <div className="relative">
                {/* Continuous Background Track Line */}
                <div className="absolute left-[31px] sm:left-[35px] lg:left-[39px] xl:left-[35px] 2xl:left-[39px] top-6 bottom-8 w-[2px] bg-surface-container-highest dark:bg-slate-700/60 rounded-full pointer-events-none" />

                {currentDay.items.map((item, idx) => {
                  const isZeroStay = item.duration_minutes === 0;
                  const prevSameTime =
                    idx > 0 && currentDay.items[idx - 1].start_time === item.start_time;
                  const hasCachedGuide = item.cached_styles.length > 0;
                  const isSelectedGuide = activeGuideItemId === item.item_id;

                  return (
                    <article
                      key={item.item_id}
                      className="relative flex items-start gap-2.5 sm:gap-3.5 mb-5 group"
                    >
                      {/* Left Time Pillar */}
                      <div className="w-16 sm:w-[72px] lg:w-20 xl:w-[72px] 2xl:w-20 shrink-0 pt-3 flex flex-col items-center">
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
                        onClick={() => onSelectGuide(item)}
                        className={`flex-1 min-w-0 rounded-xl p-space-md sm:p-5 cursor-pointer hover:shadow-md transition-all ${
                          isZeroStay
                            ? 'bg-surface-container-low dark:bg-[#1A1D24] dark:border dark:border-white/[0.06] shadow-xs'
                            : 'bg-surface-container-lowest dark:bg-[#1E2026] dark:border dark:border-white/[0.08] shadow-sm'
                        } ${isSelectedGuide ? 'ring-2 ring-primary-container/70 shadow-md' : ''}`}
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
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectGuide(item);
                            }}
                            aria-label="AI 導覽"
                            title="AI 導覽"
                            className="relative w-9 h-9 rounded-full inline-flex items-center justify-center text-primary dark:text-[#ff9c85] bg-primary-fixed/45 dark:bg-primary/20 hover:bg-primary-fixed dark:hover:bg-primary/30 transition-colors active:scale-95"
                          >
                            <span
                              aria-hidden="true"
                              className="material-symbols-outlined text-[18px] select-none"
                            >
                              auto_awesome
                            </span>
                            {hasCachedGuide && (
                              <span
                                title="已有導覽快取"
                                className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-tertiary dark:bg-emerald-400 ring-2 ring-surface-container-lowest dark:ring-[#1E2026]"
                              />
                            )}
                          </button>

                          {hasCachedGuide && (
                            <span
                              aria-label="已備妥導覽"
                              title="已備妥導覽"
                              className="text-tertiary dark:text-emerald-400 inline-flex items-center justify-center"
                            >
                              <span
                                aria-hidden="true"
                                className="material-symbols-outlined text-[16px] select-none"
                              >
                                check_circle
                              </span>
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

          {/* Persistent Desktop Right Split Pane / Responsive Overlay Sheet */}
          {renderGuidePanel?.(currentDay?.items ?? [])}
        </div>
      </main>

      {/* Floating Action Button (Day AI Chat — Mobile/Tablet/Small Desktop) */}
      <aside className="fixed bottom-5 right-5 sm:bottom-6 sm:right-6 lg:bottom-8 lg:right-8 z-40 flex items-center pb-safe xl:hidden">
        <button
          type="button"
          onClick={() => setDayChatOpen(true)}
          aria-label="開啟當天 AI 行程助手"
          title="當天 AI 行程助手"
          className="w-14 h-14 rounded-full bg-primary-container text-on-primary flex items-center justify-center shadow-lg hover:shadow-xl active:scale-95 transition-all duration-200"
        >
          <span aria-hidden="true" className="material-symbols-outlined text-[26px] select-none">
            auto_awesome
          </span>
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
