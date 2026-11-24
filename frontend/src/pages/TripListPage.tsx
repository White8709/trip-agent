import React, { useEffect, useMemo, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { TripSummary } from '../lib/api';
import { formatTotalStay } from '../lib/parser';

interface TripListPageProps {
  trips: TripSummary[];
  activeTripId: string | null;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenDeviceModal: () => void;
  onOpenTrip: (tripId: string) => void;
  onOpenImportNew: () => void;
  onUpdateTrip: (tripId: string) => void;
  onDeleteTrip: (tripId: string) => Promise<void>;
}

type SortMode = 'updated' | 'start';

function formatDateRange(t: TripSummary): string | null {
  if (!t.start_date && !t.end_date) return null;
  if (!t.start_date || !t.end_date || t.start_date === t.end_date) {
    return (t.start_date ?? t.end_date) as string;
  }
  return `${t.start_date} ~ ${t.end_date}`;
}

export const TripListPage: React.FC<TripListPageProps> = ({
  trips,
  activeTripId,
  isDark,
  onToggleTheme,
  onOpenDeviceModal,
  onOpenTrip,
  onOpenImportNew,
  onUpdateTrip,
  onDeleteTrip,
}) => {
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>('updated');
  const [pendingDelete, setPendingDelete] = useState<TripSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  useBodyScrollLock(pendingDelete !== null);

  useEffect(() => {
    if (!pendingDelete) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !deleting) setPendingDelete(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [pendingDelete, deleting]);

  const visibleTrips = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? trips.filter((t) => {
          const range = formatDateRange(t) ?? '';
          return t.title.toLowerCase().includes(q) || range.toLowerCase().includes(q);
        })
      : trips.slice();
    if (sortMode === 'start') {
      filtered.sort((a, b) => {
        if (!a.start_date && !b.start_date) return 0;
        if (!a.start_date) return 1;
        if (!b.start_date) return -1;
        return a.start_date.localeCompare(b.start_date);
      });
    } else {
      filtered.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    }
    return filtered;
  }, [trips, query, sortMode]);

  const handleConfirmDelete = async () => {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await onDeleteTrip(pendingDelete.id);
      setPendingDelete(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : '刪除失敗，請稍後再試。');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-surface dark:bg-[#121316] text-on-surface dark:text-[#E2E8F0] transition-colors duration-200">
      <header className="fixed top-0 inset-x-0 z-40 pt-safe bg-surface/85 dark:bg-[#121316]/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.04)] dark:shadow-[0_1px_8px_rgba(0,0,0,0.4)] dark:border-b dark:border-white/[0.08] transition-colors duration-200">
        <div className="h-16 px-margin md:px-margin-desktop max-w-[720px] lg:max-w-[1140px] xl:max-w-[1440px] mx-auto w-full flex items-center justify-between gap-2 lg:gap-4">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-full bg-primary-fixed/60 dark:bg-primary/20 flex items-center justify-center shrink-0">
              <span className="material-symbols-outlined text-primary dark:text-[#ff9c85] text-[20px]">
                auto_stories
              </span>
            </div>
            <h1 className="font-headline-md text-headline-md text-on-surface dark:text-white tracking-tight truncate select-none">
              我的行程
            </h1>
            <span className="inline-flex items-center px-2.5 py-0.5 rounded-full bg-surface-container-low dark:bg-[#24272E] text-label-sm font-label-sm text-on-surface-variant dark:text-slate-300 shrink-0 tabular-nums">
              {trips.length}
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
            <button
              type="button"
              onClick={onOpenDeviceModal}
              aria-label="裝置識別與同步"
              title="裝置識別與同步"
              className="w-8 h-8 rounded-full bg-primary dark:bg-[#FF6B4A] flex items-center justify-center shrink-0 shadow-sm active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </button>
            <button
              type="button"
              onClick={onOpenImportNew}
              aria-label="新增行程"
              title="新增行程"
              className="inline-flex items-center gap-1 h-9 pl-2.5 pr-3 rounded-full bg-primary-container dark:bg-[#FF785A] text-on-primary font-label-md text-label-md shadow-sm hover:opacity-95 active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              <span className="hidden min-[400px]:inline">新增行程</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 flex flex-col w-full max-w-[720px] lg:max-w-[1140px] xl:max-w-[1440px] mx-auto px-margin md:px-margin-desktop pt-[88px] md:pt-24 pb-10 gap-4 lg:gap-5">
        {/* Search & Sort */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2.5">
          <div className="relative flex-1 min-w-0">
            <span className="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none">
              search
            </span>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜尋行程名稱或日期..."
              aria-label="搜尋行程"
              className="w-full h-11 pl-10 pr-10 rounded-xl bg-surface-container-lowest dark:bg-[#1c2128] border border-transparent dark:border-[#2E3440] shadow-sm dark:shadow-none text-body-sm font-body-sm text-on-surface dark:text-[#E2E8F0] placeholder:text-on-surface-variant/50 dark:placeholder:text-[#64748B] focus:outline-none focus:ring-1 focus:ring-primary/40 transition-all"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery('')}
                aria-label="清除搜尋"
                title="清除搜尋"
                className="absolute right-2 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#24272E] active:scale-95 transition-all"
              >
                <span className="material-symbols-outlined text-[18px]">close</span>
              </button>
            )}
          </div>

          <div
            role="radiogroup"
            aria-label="排序方式"
            className="inline-flex p-1 rounded-xl bg-surface-container-low dark:bg-[#1c2128] dark:border dark:border-[#2E3440] shrink-0 self-start sm:self-auto"
          >
            {(
              [
                ['updated', '最近更新'],
                ['start', '出發日期'],
              ] as const
            ).map(([mode, label]) => {
              const active = sortMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setSortMode(mode)}
                  className={`h-9 px-3.5 rounded-lg font-label-md text-label-md transition-all active:scale-95 ${
                    active
                      ? 'bg-primary-container dark:bg-[#FF785A] text-on-primary shadow-sm'
                      : 'text-on-surface-variant dark:text-slate-300 hover:text-on-surface dark:hover:text-white'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Grid */}
        {visibleTrips.length === 0 ? (
          <div className="rounded-xl border border-dashed border-surface-container-highest dark:border-[#2E3440] bg-surface-container-low/60 dark:bg-[#1a202c]/50 p-8 flex flex-col items-center gap-2 text-center">
            <span className="material-symbols-outlined text-[32px] text-on-surface-variant dark:text-slate-400">
              search_off
            </span>
            <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-slate-400">
              {trips.length === 0 ? '還沒有任何行程，點擊「新增行程」開始匯入。' : '找不到符合的行程。'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-5">
            {visibleTrips.map((t) => {
              const isActive = t.id === activeTripId;
              const range = formatDateRange(t);
              return (
                <article
                  key={t.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenTrip(t.id)}
                  onKeyDown={(e) => {
                    if (e.target !== e.currentTarget) return;
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onOpenTrip(t.id);
                    }
                  }}
                  className={`group cursor-pointer rounded-xl p-4 sm:p-5 flex flex-col gap-3 shadow-sm dark:shadow-none transition-all hover:shadow-md active:scale-[0.99] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
                    isActive
                      ? 'bg-primary-fixed/30 dark:bg-primary/10 border border-primary/30 dark:border-primary/40'
                      : 'bg-surface-container-lowest dark:bg-[#1c2128] border border-transparent dark:border-[#2E3440] hover:bg-surface-container-low/60 dark:hover:bg-[#20252d]'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-headline-sm text-headline-sm text-on-surface dark:text-white tracking-tight break-words min-w-0">
                      {t.title}
                    </h2>
                    {isActive && (
                      <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full bg-primary-container/90 dark:bg-[#FF785A] text-on-primary text-label-sm font-label-sm">
                        目前檢視
                      </span>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 text-on-surface-variant dark:text-[#94A3B8]">
                    {range && (
                      <p className="inline-flex items-center gap-1.5 text-body-sm font-body-sm tabular-nums">
                        <span className="material-symbols-outlined text-[16px] text-primary dark:text-[#FF8469]">
                          calendar_today
                        </span>
                        {range}
                      </p>
                    )}
                    <p className="inline-flex items-center gap-1.5 text-body-sm font-body-sm">
                      <span className="material-symbols-outlined text-[16px] text-secondary dark:text-[#7db6ff]">
                        schedule
                      </span>
                      {t.day_count} 天 ・ {t.item_count} 個景點 ・ 總停留{' '}
                      {formatTotalStay(t.total_duration_minutes)}
                    </p>
                    {t.cached_guide_item_count > 0 && (
                      <span className="self-start inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-tertiary-fixed/40 dark:bg-[#132c18]/70 text-on-tertiary-container dark:text-[#88d982] text-label-sm font-label-sm">
                        <span className="material-symbols-outlined text-[14px]">auto_awesome</span>
                        已備妥 {t.cached_guide_item_count}/{t.item_count} 站導覽
                      </span>
                    )}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-2 mt-auto border-t border-surface-container-high/60 dark:border-white/[0.08]">
                    <div className="min-w-0">
                      {t.share_url && (
                        <a
                          href={t.share_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          aria-label="開啟去趣原行程"
                          title="開啟去趣原行程"
                          className="inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-secondary dark:text-sky-400 hover:bg-surface-container dark:hover:bg-[#24272E] transition-colors font-label-md text-label-md"
                        >
                          <span>原行程</span>
                          <span className="material-symbols-outlined text-[15px]">open_in_new</span>
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onUpdateTrip(t.id);
                        }}
                        aria-label="更新行程"
                        title="更新行程"
                        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-on-surface-variant dark:text-slate-300 hover:text-primary dark:hover:text-[#FF8469] hover:bg-surface-container dark:hover:bg-[#24272E] active:scale-95 transition-all font-label-md text-label-md"
                      >
                        <span className="material-symbols-outlined text-[16px]">edit_note</span>
                        <span className="hidden min-[360px]:inline">更新行程</span>
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteError(null);
                          setPendingDelete(t);
                        }}
                        aria-label="刪除行程"
                        title="刪除行程"
                        className="inline-flex items-center gap-1 h-8 px-2.5 rounded-full text-on-surface-variant dark:text-slate-300 hover:text-error dark:hover:text-rose-300 hover:bg-error-container/40 dark:hover:bg-rose-950/40 active:scale-95 transition-all font-label-md text-label-md"
                      >
                        <span className="material-symbols-outlined text-[16px]">delete</span>
                        <span className="hidden min-[360px]:inline">刪除行程</span>
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>

      {/* Delete confirmation */}
      {pendingDelete && (
        <div
          className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center bg-black/50 backdrop-blur-sm p-0 sm:p-4"
          onClick={() => {
            if (!deleting) setPendingDelete(null);
          }}
        >
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-trip-title"
            onClick={(e) => e.stopPropagation()}
            className="w-full sm:max-w-md bg-surface dark:bg-[#1c1f26] rounded-t-3xl sm:rounded-2xl shadow-2xl border border-transparent dark:border-white/[0.1] p-5 pb-safe flex flex-col gap-4"
          >
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full bg-error-container dark:bg-rose-950/60 text-error dark:text-rose-300 flex items-center justify-center shrink-0">
                <span className="material-symbols-outlined text-[22px]">delete_forever</span>
              </div>
              <div className="flex flex-col gap-1 min-w-0">
                <h2
                  id="delete-trip-title"
                  className="font-headline-sm text-headline-sm text-on-surface dark:text-white break-words"
                >
                  刪除「{pendingDelete.title}」？
                </h2>
                <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-slate-400 leading-relaxed">
                  此行程的所有景點資料、已生成的 AI 導覽與語音音檔快取都會一併永久刪除，且無法復原。
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="bg-error-container dark:bg-rose-950/60 text-on-error-container dark:text-rose-200 rounded-xl p-3 text-body-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
                <span>{deleteError}</span>
              </div>
            )}

            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pb-3 sm:pb-0">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                disabled={deleting}
                className="h-11 px-5 rounded-xl bg-surface-container-low dark:bg-[#24272E] text-on-surface dark:text-slate-200 font-label-md text-label-md hover:bg-surface-container dark:hover:bg-[#2A2D35] active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleConfirmDelete()}
                disabled={deleting}
                className="h-11 px-5 rounded-xl bg-error dark:bg-rose-600 text-on-error font-label-md text-label-md inline-flex items-center justify-center gap-2 shadow-sm hover:opacity-95 active:scale-95 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {deleting && (
                  <span className="material-symbols-outlined text-[18px] animate-spin">
                    progress_activity
                  </span>
                )}
                <span>{deleting ? '刪除中...' : '確認刪除'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
