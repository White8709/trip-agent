import React, { useEffect, useMemo, useRef, useState } from 'react';
import { importTrip, Trip, TripSummary, updateTrip, UpdateTripResult } from '../lib/api';
import {
  formatStayDuration,
  formatTotalStay,
  parseChicTripPreview,
  SAMPLE_CHICTRIP_TEXT,
} from '../lib/parser';

interface ImportPageProps {
  canGoBack: boolean;
  isDark: boolean;
  onToggleTheme: () => void;
  onOpenDeviceModal: () => void;
  onBack: () => void;
  onImported: (trip: Trip) => void;
  existingTrips: TripSummary[];
  updatingTrip?: Trip | null;
  onUpdated?: (result: UpdateTripResult) => void;
}

export const ImportPage: React.FC<ImportPageProps> = ({
  canGoBack,
  isDark,
  onToggleTheme,
  onOpenDeviceModal,
  onBack,
  onImported,
  existingTrips,
  updatingTrip = null,
  onUpdated,
}) => {
  const [rawText, setRawText] = useState('');
  const [saveMode, setSaveMode] = useState<'overwrite' | 'new'>('overwrite');
  const isUpdateMode = updatingTrip !== null;
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const parseResult = useMemo(() => parseChicTripPreview(rawText), [rawText]);
  const duplicateTrip = useMemo(() => {
    if (isUpdateMode || !parseResult.ok) return null;
    const title = parseResult.data.title.trim();
    return existingTrips.find((t) => t.title.trim() === title) ?? null;
  }, [isUpdateMode, parseResult, existingTrips]);
  const duplicateId = duplicateTrip?.id ?? null;

  // Reset the form cleanly whenever the target mode/trip changes.
  useEffect(() => {
    setRawText('');
    setSubmitError(null);
    setClipboardNotice(null);
  }, [updatingTrip?.id]);

  // Default to overwrite whenever a (new) duplicate is detected.
  useEffect(() => {
    if (duplicateId) setSaveMode('overwrite');
  }, [duplicateId]);

  const overwriteTarget = isUpdateMode
    ? { id: updatingTrip.id, title: updatingTrip.title }
    : duplicateTrip && saveMode === 'overwrite'
      ? { id: duplicateTrip.id, title: duplicateTrip.title }
      : null;

  const charCount = rawText.length;
  const lineCount = rawText.trim() ? rawText.split(/\r?\n/).length : 0;

  const handlePaste = async () => {
    setClipboardNotice(null);
    setSubmitError(null);
    try {
      if (navigator.clipboard && navigator.clipboard.readText) {
        const text = await navigator.clipboard.readText();
        if (text) {
          setRawText(text);
          return;
        }
      }
      textareaRef.current?.focus();
      setClipboardNotice('剪貼簿目前沒有文字，請直接貼上於輸入框中。');
    } catch {
      textareaRef.current?.focus();
      setClipboardNotice('請直接在輸入框長按或按 Ctrl/Cmd+V 貼上行程內容。');
    }
  };

  const handleUseSample = () => {
    setSubmitError(null);
    setClipboardNotice(null);
    setRawText(SAMPLE_CHICTRIP_TEXT);
  };

  const handleFillCurrentText = () => {
    if (!updatingTrip) return;
    setSubmitError(null);
    setClipboardNotice(null);
    setRawText(updatingTrip.raw_text ?? '');
  };

  const handleClear = () => {
    setSubmitError(null);
    setClipboardNotice(null);
    setRawText('');
    textareaRef.current?.focus();
  };

  const handleSubmit = async () => {
    if (!parseResult.ok || submitting) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (overwriteTarget) {
        const result = await updateTrip(overwriteTarget.id, rawText);
        if (onUpdated) onUpdated(result);
        else onImported(result.trip);
      } else {
        const trip = await importTrip(rawText);
        onImported(trip);
      }
    } catch (err) {
      setSubmitError(
        err instanceof Error
          ? err.message
          : overwriteTarget
            ? '更新失敗，請檢查行程格式。'
            : '匯入失敗，請檢查行程格式。',
      );
    } finally {
      setSubmitting(false);
    }
  };

  const firstDay = parseResult.ok ? parseResult.data.days[0] : null;
  const previewItems = firstDay ? firstDay.items.slice(0, 6) : [];

  return (
    <div className="min-h-screen flex flex-col bg-surface dark:bg-[#121417] text-on-surface dark:text-[#E2E8F0] transition-colors duration-300">
      {/* Fixed Minimalist Header */}
      <header className="fixed top-0 inset-x-0 z-40 bg-surface/85 dark:bg-[#121417]/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(0,0,0,0.03)] dark:shadow-[0_1px_8px_rgba(0,0,0,0.4)] border-b border-transparent dark:border-[#2E3440]/60 pt-safe transition-colors duration-300">
        <div className="h-14 px-margin md:px-margin-desktop flex items-center justify-between max-w-[720px] lg:max-w-[1140px] mx-auto w-full">
          {canGoBack ? (
            <button
              type="button"
              onClick={onBack}
              aria-label={isUpdateMode ? '取消更新並返回' : '返回'}
              className="w-11 h-11 flex items-center justify-center rounded-full text-on-surface dark:text-[#E2E8F0] hover:bg-surface-container-high/60 dark:hover:bg-[#22262E] transition-colors active:scale-95"
            >
              <span className="material-symbols-outlined text-[20px]">arrow_back_ios_new</span>
            </button>
          ) : (
            <div className="w-11 h-11 flex items-center justify-center text-primary dark:text-[#FF8469]">
              <span className="material-symbols-outlined text-[22px]">travel_explore</span>
            </div>
          )}

          <h1 className="text-headline-sm font-headline-sm text-on-surface dark:text-[#E2E8F0] tracking-tight text-center truncate max-w-[180px] sm:max-w-[320px] md:max-w-none">
            {isUpdateMode ? '更新去趣行程' : '匯入去趣行程'}
          </h1>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={onToggleTheme}
              aria-label="切換深淺模式"
              title="切換深淺模式"
              className="w-9 h-9 rounded-full bg-surface-container-low dark:bg-[#22262E] border border-surface-container-high/50 dark:border-[#2E3440] flex items-center justify-center text-on-surface dark:text-[#E2E8F0] hover:scale-105 active:scale-95 transition-all shadow-sm"
            >
              <span className="material-symbols-outlined text-[19px] text-[#ae3115] dark:text-[#FFB4A3]">
                {isDark ? 'light_mode' : 'dark_mode'}
              </span>
            </button>
            <button
              type="button"
              onClick={onOpenDeviceModal}
              aria-label="裝置識別與同步"
              title="裝置識別與同步"
              className="w-8 h-8 rounded-full bg-primary dark:bg-[#FF6B4A] flex items-center justify-center shadow-sm active:scale-95 transition-transform"
            >
              <span className="material-symbols-outlined text-on-primary text-[18px]">person</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 flex flex-col relative w-full max-w-[720px] lg:max-w-[1140px] mx-auto px-margin md:px-margin-desktop pt-[72px] md:pt-[84px] pb-36 md:pb-28">
        <div className="flex flex-col gap-4 lg:grid lg:grid-cols-12 lg:gap-gutter-desktop lg:items-start">
          {/* Left Column: Guidance & Input */}
          <div className="lg:col-span-7 flex flex-col gap-4">
            {isUpdateMode && (
              <div className="bg-primary-fixed/40 dark:bg-primary/15 rounded-xl p-4 sm:p-5 border border-primary/15 dark:border-primary/25 flex items-start gap-3">
                <div className="w-8 h-8 rounded-full bg-primary-container/90 dark:bg-[#FF6B4A] text-on-primary flex items-center justify-center shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[18px]">edit_note</span>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="font-headline-sm text-body-md text-on-surface dark:text-[#F1F5F9] font-semibold tracking-tight break-words">
                    正在更新「{updatingTrip.title}」
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant dark:text-[#94A3B8] leading-relaxed">
                    貼上新版去趣文字後送出，將覆蓋此行程內容；同名景點已生成的 AI 導覽與語音快取會自動保留。
                  </p>
                </div>
              </div>
            )}

            {/* Guidance Banner */}
            <div className="bg-surface-container-low dark:bg-[#1a202c]/70 rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-none border border-transparent dark:border-[#2E3440] relative overflow-hidden transition-colors">
              <div className="absolute -right-4 -bottom-6 w-24 h-24 bg-secondary-container/20 dark:bg-secondary-container/10 rounded-full blur-xl pointer-events-none" />
              <div className="flex items-start gap-3 relative z-10">
                <div className="w-8 h-8 rounded-full bg-secondary-container dark:bg-[#1960a3]/30 text-on-secondary-container dark:text-[#a2c9ff] flex items-center justify-center shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-[18px]">info</span>
                </div>
                <div className="flex flex-col gap-1 min-w-0">
                  <p className="font-headline-sm text-body-md text-on-surface dark:text-[#F1F5F9] font-semibold tracking-tight">
                    請貼上從「去趣」匯出的純文字行程
                  </p>
                  <p className="font-body-sm text-body-sm text-on-surface-variant dark:text-[#94A3B8] leading-relaxed">
                    系統將 100% 忠實解析每日景點與停留時間，並為每個站點提供專屬 Gemini AI 圖文與語音導覽。
                  </p>
                </div>
              </div>
            </div>

            {/* Notebook Input Card */}
            <div className="bg-surface-container-lowest dark:bg-[#1c2128] rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-none border border-transparent dark:border-[#2E3440] flex flex-col gap-3 relative transition-all">
              <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={handlePaste}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-low dark:bg-[#262c36] text-primary dark:text-[#FF8469] hover:bg-primary-fixed dark:hover:bg-[#343c4a] transition-colors active:scale-95 text-label-md font-label-md"
                >
                  <span className="material-symbols-outlined text-[16px]">content_paste</span>
                  <span>貼上剪貼簿</span>
                </button>
                {isUpdateMode && (
                  <button
                    type="button"
                    onClick={handleFillCurrentText}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-surface-container-low dark:bg-[#262c36] text-secondary dark:text-[#7db6ff] hover:bg-secondary-container/50 dark:hover:bg-[#343c4a] transition-colors active:scale-95 text-label-md font-label-md"
                  >
                    <span className="material-symbols-outlined text-[16px]">history_edu</span>
                    <span>帶入目前文字</span>
                  </button>
                )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={handleUseSample}
                    title="填入範例行程"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-on-surface-variant dark:text-[#94A3B8] hover:text-primary dark:hover:text-[#FF8469] hover:bg-surface-container-low dark:hover:bg-[#262c36] transition-colors text-label-md font-label-md"
                  >
                    <span className="material-symbols-outlined text-[16px]">auto_stories</span>
                    <span>範例</span>
                  </button>
                  <button
                    type="button"
                    onClick={handleClear}
                    aria-label="清除全部內容"
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-full text-on-surface-variant dark:text-[#94A3B8] hover:text-error hover:bg-error-container/40 dark:hover:bg-error-container/20 transition-colors text-label-md font-label-md"
                  >
                    <span className="material-symbols-outlined text-[16px]">delete_sweep</span>
                    <span>清除</span>
                  </button>
                </div>
              </div>

              {clipboardNotice && (
                <p className="text-label-sm font-label-sm text-secondary dark:text-sky-400 px-1">
                  {clipboardNotice}
                </p>
              )}

              <textarea
                ref={textareaRef}
                value={rawText}
                onChange={(e) => {
                  setRawText(e.target.value);
                  if (submitError) setSubmitError(null);
                }}
                rows={9}
                placeholder={`在此貼上去趣純文字行程內容...\n\n行程名稱：2026大阪\n第1天 (2026/11/26)\n11:10 關西國際機場 (停留 01時30分)\n14:03 KATO 京都駅店 (停留 01時00分)`}
                className="w-full min-h-[200px] sm:min-h-[240px] lg:min-h-[360px] bg-surface-container-low/40 dark:bg-[#14181f] rounded-lg p-3.5 text-body-sm font-body-sm text-on-surface dark:text-[#E2E8F0] placeholder:text-on-surface-variant/45 dark:placeholder:text-[#64748B] focus:outline-none focus:bg-surface-container-lowest dark:focus:bg-[#14181f] focus:ring-1 focus:ring-primary/40 dark:focus:ring-primary-container/60 resize-y leading-relaxed transition-all tracking-wide border border-transparent dark:border-[#2a303c]"
              />

              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1 text-label-sm font-label-sm text-on-surface-variant dark:text-[#94A3B8]">
                {parseResult.ok ? (
                  <div className="flex items-center gap-1.5 text-tertiary dark:text-[#6ee77a]">
                    <span className="w-1.5 h-1.5 rounded-full bg-tertiary dark:bg-[#6ee77a] animate-pulse" />
                    <span>格式即時解析正常</span>
                  </div>
                ) : rawText.trim() ? (
                  <div className="flex items-center gap-1.5 text-error dark:text-rose-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-error dark:bg-rose-400" />
                    <span>格式待調整</span>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-on-surface-variant dark:text-slate-400">
                    <span className="w-1.5 h-1.5 rounded-full bg-outline/50" />
                    <span>等待輸入中...</span>
                  </div>
                )}
                <span className="tabular-nums">
                  已輸入 {charCount} 字 / {lineCount} 行
                </span>
              </div>
            </div>

            {submitError && (
              <div className="bg-error-container dark:bg-rose-950/60 text-on-error-container dark:text-rose-200 rounded-xl p-3 text-body-sm flex items-center gap-2">
                <span className="material-symbols-outlined text-[18px] shrink-0">error</span>
                <span>{submitError}</span>
              </div>
            )}
          </div>

          {/* Right Column: Live Recognition, Snapshot Preview & Guide */}
          <div className="lg:col-span-5 lg:sticky lg:top-[84px] flex flex-col gap-4">
            {/* Real-time Recognition Card */}
            {parseResult.ok ? (
              <div className="bg-tertiary-fixed/30 dark:bg-[#132c18]/60 rounded-xl p-3.5 sm:p-4 shadow-sm dark:shadow-none border border-transparent dark:border-[#22502c]/50 flex flex-col gap-2 transition-all">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded-full bg-tertiary dark:bg-[#238636] text-on-tertiary flex items-center justify-center shrink-0">
                      <span className="material-symbols-outlined text-[15px]">check</span>
                    </div>
                    <span className="font-headline-sm text-body-sm font-semibold text-on-tertiary-container dark:text-[#88d982]">
                      已成功辨識 {parseResult.data.days.length} 天行程・{parseResult.data.totalItems} 個景點
                    </span>
                  </div>
                  <span className="text-label-sm font-label-sm px-2 py-0.5 rounded-full bg-tertiary/10 dark:bg-tertiary-container/30 text-on-tertiary-container dark:text-[#a3f69c] shrink-0">
                    就緒
                  </span>
                </div>

                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container-lowest dark:bg-[#1c2128] text-on-surface-variant dark:text-[#CBD5E1] text-label-sm font-label-sm shadow-sm dark:border dark:border-[#2E3440]">
                    <span className="material-symbols-outlined text-[14px] text-primary dark:text-[#FF8469]">
                      calendar_today
                    </span>
                    {parseResult.data.dateRangeText}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container-lowest dark:bg-[#1c2128] text-on-surface-variant dark:text-[#CBD5E1] text-label-sm font-label-sm shadow-sm dark:border dark:border-[#2E3440]">
                    <span className="material-symbols-outlined text-[14px] text-secondary dark:text-[#7db6ff]">
                      explore
                    </span>
                    {parseResult.data.title}
                  </span>
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full bg-surface-container-lowest dark:bg-[#1c2128] text-on-surface-variant dark:text-[#CBD5E1] text-label-sm font-label-sm shadow-sm dark:border dark:border-[#2E3440]">
                    <span className="material-symbols-outlined text-[14px] text-tertiary dark:text-[#6ee77a]">
                      schedule
                    </span>
                    總停留 {formatTotalStay(parseResult.data.totalDurationMinutes)}
                  </span>
                </div>
              </div>
            ) : rawText.trim() ? (
              <div className="bg-error-container/60 dark:bg-rose-950/40 rounded-xl p-3.5 border border-error/20 dark:border-rose-500/30 flex items-center gap-2 text-on-error-container dark:text-rose-200 text-body-sm">
                <span className="material-symbols-outlined text-[18px] shrink-0">warning</span>
                <span>{parseResult.error}</span>
              </div>
            ) : (
              <div className="hidden lg:flex bg-surface-container-low/70 dark:bg-[#1a202c]/50 rounded-xl p-5 border border-dashed border-surface-container-highest dark:border-[#2E3440] flex-col gap-2">
                <div className="flex items-center gap-2 text-on-surface dark:text-[#F1F5F9]">
                  <span className="material-symbols-outlined text-[20px] text-primary dark:text-[#FF8469]">
                    view_timeline
                  </span>
                  <h2 className="font-headline-sm text-body-md font-semibold">即時行程預覽</h2>
                </div>
                <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-[#94A3B8] leading-relaxed">
                  於左側貼上去趣純文字行程或點擊「範例」後，此處會即時顯示總天數、總停留時長與第 1 天時間軸快照供確認。
                </p>
              </div>
            )}

            {duplicateTrip && (
              <div
                role="radiogroup"
                aria-label="匯入方式"
                className="bg-surface-container-lowest dark:bg-[#1c2128] rounded-xl p-3 sm:p-4 shadow-sm dark:shadow-none border border-transparent dark:border-[#2E3440] flex flex-col gap-2"
              >
                <p className="text-label-md font-label-md text-on-surface-variant dark:text-[#94A3B8] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[16px] text-secondary dark:text-[#7db6ff]">
                    content_copy
                  </span>
                  已有同名行程，請選擇處理方式
                </p>
                {([
                  ['overwrite', `覆蓋更新既有「${duplicateTrip.title}」（保留同名景點導覽快取）`],
                  ['new', '另存為新行程'],
                ] as const).map(([value, label]) => {
                  const active = saveMode === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setSaveMode(value)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg flex items-start gap-2.5 text-body-sm font-body-sm transition-colors border ${
                        active
                          ? 'bg-primary-fixed/50 dark:bg-primary/20 border-primary/30 text-on-surface dark:text-[#F1F5F9]'
                          : 'bg-surface-container-low/60 dark:bg-[#14181f] border-transparent dark:border-[#2a303c] text-on-surface-variant dark:text-[#94A3B8] hover:bg-surface-container-low dark:hover:bg-[#1a202c]'
                      }`}
                    >
                      <span className="material-symbols-outlined text-[18px] shrink-0 mt-px text-primary dark:text-[#FF8469]">
                        {active ? 'radio_button_checked' : 'radio_button_unchecked'}
                      </span>
                      <span className="break-words min-w-0">{label}</span>
                    </button>
                  );
                })}
              </div>
            )}

            {/* Dynamic Day 1 Timeline Snapshot */}
            {firstDay && previewItems.length > 0 && (
              <div className="bg-surface-container-lowest dark:bg-[#1c2128] rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-none border border-transparent dark:border-[#2E3440] flex flex-col gap-3 transition-colors">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="material-symbols-outlined text-primary dark:text-[#FF8469] text-[20px]">
                      view_timeline
                    </span>
                    <h2 className="font-headline-sm text-body-md font-semibold text-on-surface dark:text-[#F1F5F9]">
                      時間軸即時快照
                    </h2>
                  </div>
                  <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-[#94A3B8] shrink-0">
                    第 {firstDay.day_number} 天預覽
                  </span>
                </div>

                <div className="lg:max-h-[360px] lg:overflow-y-auto pr-1">
                  <div className="relative pl-6 flex flex-col gap-3 pt-1">
                    <div className="absolute left-2 top-2.5 bottom-2.5 w-0.5 bg-surface-container-high dark:bg-[#2E3440]" />
                    {previewItems.map((item, idx) => (
                      <div
                        key={`${item.sequence}-${item.start_time}`}
                        className="relative flex items-start justify-between gap-2"
                      >
                        <div
                          className={`absolute -left-[19px] top-1.5 w-2 h-2 rounded-full ring-4 ring-surface-container-lowest dark:ring-[#1c2128] ${
                            idx === 0
                              ? 'bg-primary dark:bg-[#FF8469]'
                              : 'bg-surface-container-highest dark:bg-[#343e50]'
                          }`}
                        />
                        <div className="min-w-0">
                          <p className="font-headline-sm text-body-sm font-medium text-on-surface dark:text-[#E2E8F0] break-words">
                            {item.name}
                          </p>
                          <p className="text-label-sm font-label-sm text-on-surface-variant dark:text-[#94A3B8] tabular-nums">
                            {item.start_time} ・ {formatStayDuration(item.duration_minutes)}
                          </p>
                        </div>
                        <span className="text-label-sm font-label-sm px-2 py-0.5 rounded-full bg-surface-container dark:bg-[#252c38] text-on-surface-variant dark:text-[#94A3B8] shrink-0 tabular-nums">
                          #{item.sequence}
                        </span>
                      </div>
                    ))}
                    {firstDay.items.length > previewItems.length && (
                      <p className="text-label-sm font-label-sm text-outline dark:text-slate-400">
                        還有 {firstDay.items.length - previewItems.length} 個景點...
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Guide Accordion */}
            <details className="group bg-surface-container-lowest dark:bg-[#1c2128] rounded-xl p-4 sm:p-5 shadow-sm dark:shadow-none border border-transparent dark:border-[#2E3440] transition-all [&_summary::-webkit-details-marker]:hidden">
              <summary className="flex items-center justify-between cursor-pointer select-none">
                <div className="flex items-center gap-2">
                  <span className="material-symbols-outlined text-[20px] text-secondary dark:text-[#7db6ff]">
                    help_center
                  </span>
                  <span className="font-headline-sm text-body-sm font-semibold text-on-surface dark:text-[#F1F5F9]">
                    如何從「去趣」匯出文字行程？
                  </span>
                </div>
                <span className="material-symbols-outlined text-[20px] text-on-surface-variant dark:text-[#94A3B8] transition-transform group-open:rotate-180">
                  expand_more
                </span>
              </summary>
              <div className="pt-3 mt-3 border-t border-surface-container-high/40 dark:border-[#2E3440] flex flex-col gap-2.5">
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-surface-container-high dark:bg-[#262c36] text-on-surface dark:text-[#E2E8F0] flex items-center justify-center text-label-sm font-label-sm font-bold shrink-0 mt-0.5">
                    1
                  </div>
                  <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-[#94A3B8]">
                    開啟「去趣」App，進入欲匯出的旅行計劃頁面。
                  </p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-surface-container-high dark:bg-[#262c36] text-on-surface dark:text-[#E2E8F0] flex items-center justify-center text-label-sm font-label-sm font-bold shrink-0 mt-0.5">
                    2
                  </div>
                  <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-[#94A3B8]">
                    點選右上角「分享」圖示，選擇「複製純文字行程」或匯出文字。
                  </p>
                </div>
                <div className="flex items-start gap-2.5">
                  <div className="w-5 h-5 rounded-full bg-surface-container-high dark:bg-[#262c36] text-on-surface dark:text-[#E2E8F0] flex items-center justify-center text-label-sm font-label-sm font-bold shrink-0 mt-0.5">
                    3
                  </div>
                  <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-[#94A3B8]">
                    返回本畫面點擊「貼上剪貼簿」，立即轉換為附帶 AI 導覽與語音的行程手帳！
                  </p>
                </div>
              </div>
            </details>
          </div>
        </div>
      </main>

      {/* Sticky Bottom Floating CTA */}
      <div className="fixed bottom-0 inset-x-0 z-40 bg-surface/85 dark:bg-[#121417]/85 backdrop-blur-xl pb-safe pt-2.5 px-margin md:px-margin-desktop shadow-[0_-4px_16px_rgba(0,0,0,0.04)] dark:shadow-[0_-4px_16px_rgba(0,0,0,0.5)] border-t border-transparent dark:border-[#2E3440]/60 transition-colors duration-300">
        <div className="max-w-[720px] lg:max-w-[1140px] mx-auto w-full flex flex-col md:flex-row-reverse md:items-center md:justify-between items-center gap-2 md:gap-4 pb-3">
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!parseResult.ok || submitting}
            className="w-full md:w-auto md:min-w-[220px] md:px-7 h-12 rounded-xl bg-primary-container dark:bg-[#FF785A] text-on-primary font-headline-sm text-body-md font-semibold flex items-center justify-center gap-2 shadow-md hover:opacity-95 active:scale-[0.98] transition-all disabled:opacity-45 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <span className="material-symbols-outlined text-[18px] animate-spin">
                  progress_activity
                </span>
                <span>{overwriteTarget ? '正在更新行程...' : '正在建立行程時間軸...'}</span>
              </>
            ) : (
              <>
                <span>
                  {isUpdateMode ? '更新行程' : overwriteTarget ? '覆蓋更新既有行程' : '建立行程時間軸'}
                </span>
                <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
              </>
            )}
          </button>
          <div className="flex items-center gap-1.5 text-label-sm font-label-sm text-on-surface-variant dark:text-[#94A3B8]">
            <span className="material-symbols-outlined text-[13px] text-tertiary dark:text-[#6ee77a]">
              check_circle
            </span>
            <span>支援依裝置自動儲存與跨裝置綁定碼同步</span>
          </div>
        </div>
      </div>
    </div>
  );
};
