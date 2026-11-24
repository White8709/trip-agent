import React, { useEffect, useState } from 'react';
import { useBodyScrollLock } from '../hooks/useBodyScrollLock';
import { FONT_SIZE_OPTIONS, FontSizePreset } from '../hooks/useFontSize';
import { DeviceProfile } from '../lib/api';

interface DeviceModalProps {
  isOpen: boolean;
  profile: DeviceProfile | null;
  fontSize: FontSizePreset;
  onChangeFontSize: (size: FontSizePreset) => void;
  onClose: () => void;
  onOpenImport: () => void;
  onUpdateName: (name: string) => Promise<void>;
  onBindCode: (code: string) => Promise<void>;
}

export const DeviceModal: React.FC<DeviceModalProps> = ({
  isOpen,
  profile,
  fontSize,
  onChangeFontSize,
  onClose,
  onOpenImport,
  onUpdateName,
  onBindCode,
}) => {
  const [nameInput, setNameInput] = useState('');
  const [bindInput, setBindInput] = useState('');
  const [copied, setCopied] = useState(false);
  const [savingName, setSavingName] = useState(false);
  const [binding, setBinding] = useState(false);
  const [feedback, setFeedback] = useState<{ type: 'success' | 'error'; text: string } | null>(
    null,
  );

  useEffect(() => {
    if (isOpen && profile) {
      setNameInput(profile.display_name);
      setBindInput('');
      setFeedback(null);
      setCopied(false);
    }
  }, [isOpen, profile]);

  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  useBodyScrollLock(isOpen);

  if (!isOpen) return null;

  const handleCopyCode = async () => {
    if (!profile?.binding_code) return;
    try {
      await navigator.clipboard.writeText(profile.binding_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setFeedback({ type: 'error', text: '無法自動複製，請手動選取綁定碼複製。' });
    }
  };

  const handleSaveName = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setFeedback({ type: 'error', text: '裝置名稱不可為空白。' });
      return;
    }
    setSavingName(true);
    setFeedback(null);
    try {
      await onUpdateName(trimmed);
      setFeedback({ type: 'success', text: '已更新裝置名稱。' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : '更新失敗，請稍後再試。',
      });
    } finally {
      setSavingName(false);
    }
  };

  const handleBind = async (e: React.FormEvent) => {
    e.preventDefault();
    const code = bindInput.trim().toUpperCase();
    if (!code) {
      setFeedback({ type: 'error', text: '請輸入要同步的裝置綁定碼。' });
      return;
    }
    setBinding(true);
    setFeedback(null);
    try {
      await onBindCode(code);
      setBindInput('');
      setFeedback({ type: 'success', text: '已成功同步該裝置的行程與導覽資料！' });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : '綁定失敗，請確認綁定碼是否正確。',
      });
    } finally {
      setBinding(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 md:p-6 bg-[#1A202C]/40 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-[420px] sm:max-w-[480px] md:max-w-[520px] max-h-[90dvh] overflow-y-auto overscroll-contain bg-surface-container-lowest dark:bg-[#1E2026] rounded-xl sm:rounded-2xl p-4 sm:p-5 md:p-6 shadow-xl border border-transparent dark:border-white/[0.08] flex flex-col gap-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-full bg-primary dark:bg-primary-container flex items-center justify-center text-on-primary shadow-sm">
              <span className="material-symbols-outlined text-[20px]">devices</span>
            </div>
            <div>
              <h2 className="font-headline-sm text-headline-sm text-on-surface dark:text-white font-semibold">
                裝置識別與同步
              </h2>
              <p className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400">
                免註冊自動綁定，可跨裝置轉移行程
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="關閉"
            className="w-9 h-9 rounded-full flex items-center justify-center text-on-surface-variant dark:text-slate-400 hover:bg-surface-container dark:hover:bg-[#2A2D35] transition-colors"
          >
            <span className="material-symbols-outlined text-[20px]">close</span>
          </button>
        </div>

        {feedback && (
          <div
            className={`px-3 py-2 rounded-lg text-body-sm font-body-sm flex items-center gap-2 ${
              feedback.type === 'success'
                ? 'bg-tertiary-fixed/40 dark:bg-emerald-950/60 text-on-tertiary-container dark:text-emerald-300'
                : 'bg-error-container dark:bg-rose-950/60 text-on-error-container dark:text-rose-300'
            }`}
          >
            <span className="material-symbols-outlined text-[16px]">
              {feedback.type === 'success' ? 'check_circle' : 'error'}
            </span>
            <span>{feedback.text}</span>
          </div>
        )}

        {/* Itinerary Actions */}
        <div className="flex flex-col gap-2">
          <span className="text-label-md font-label-md text-on-surface dark:text-slate-200">
            行程管理
          </span>
          <button
            type="button"
            onClick={onOpenImport}
            className="w-full h-11 px-4 rounded-xl bg-primary-fixed/50 dark:bg-primary/20 hover:bg-primary-fixed dark:hover:bg-primary/30 text-primary dark:text-[#ff9c85] font-label-md text-label-md flex items-center justify-between transition-colors active:scale-[0.99]"
          >
            <span className="inline-flex items-center gap-2">
              <span className="material-symbols-outlined text-[20px]">add_circle</span>
              <span>匯入新行程</span>
            </span>
            <span className="material-symbols-outlined text-[18px]">arrow_forward</span>
          </button>
        </div>

        <div className="border-t border-surface-container-high/70 dark:border-white/[0.08]" />

        {/* Font Size Section */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-label-md font-label-md text-on-surface dark:text-slate-200 inline-flex items-center gap-1.5">
              <span className="material-symbols-outlined text-[17px] text-primary dark:text-[#ff9c85]">
                format_size
              </span>
              <span>字體大小</span>
            </span>
            <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400">
              {FONT_SIZE_OPTIONS.find((opt) => opt.id === fontSize)?.label ?? '標準'}
            </span>
          </div>

          <div
            role="group"
            aria-label="字體大小"
            className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-surface-container-low dark:bg-[#14181F] border border-surface-container-high/60 dark:border-white/[0.06]"
          >
            {FONT_SIZE_OPTIONS.map((opt) => {
              const active = fontSize === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChangeFontSize(opt.id)}
                  className={`h-9 rounded-lg text-label-md font-label-md transition-all active:scale-95 ${
                    active
                      ? 'bg-primary-container text-on-primary shadow-sm'
                      : 'text-on-surface-variant dark:text-slate-300 hover:bg-surface-container dark:hover:bg-[#24272E]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>

          <div className="rounded-xl bg-surface-container-low/70 dark:bg-[#14181F] border border-surface-container-high/50 dark:border-white/[0.06] px-3 py-2.5">
            <p className="text-body-sm font-body-sm text-on-surface-variant dark:text-slate-300 leading-relaxed">
              預覽：11:10 關西國際機場 — 調整文字大小讓旅途閱讀更舒適
            </p>
          </div>
        </div>

        <div className="border-t border-surface-container-high/70 dark:border-white/[0.08]" />

        {/* Current Binding Code Card */}
        <div className="rounded-xl bg-surface-container-low dark:bg-[#14181F] p-3.5 border border-transparent dark:border-white/[0.06] flex flex-col gap-2">
          <span className="text-label-sm font-label-sm text-on-surface-variant dark:text-slate-400">
            本機專屬綁定碼
          </span>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <code className="font-mono text-[16px] font-bold tracking-wider text-primary dark:text-[#ff9c85] select-all">
              {profile?.binding_code ?? '載入中...'}
            </code>
            <button
              type="button"
              onClick={handleCopyCode}
              disabled={!profile?.binding_code}
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full bg-surface-container-lowest dark:bg-[#262c36] text-on-surface dark:text-slate-200 text-label-md font-label-md shadow-sm hover:bg-surface-container dark:hover:bg-[#323846] active:scale-95 transition-all"
            >
              <span className="material-symbols-outlined text-[15px]">
                {copied ? 'check' : 'content_copy'}
              </span>
              <span>{copied ? '已複製' : '複製'}</span>
            </button>
          </div>
        </div>

        {/* Rename Device */}
        <form onSubmit={handleSaveName} className="flex flex-col gap-2">
          <label className="text-label-md font-label-md text-on-surface dark:text-slate-200">
            裝置名稱
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              maxLength={40}
              placeholder="例如：Daniel 的 iPhone"
              className="flex-1 min-w-0 h-10 px-3 rounded-lg bg-surface-container-low/60 dark:bg-[#14181F] text-body-md text-on-surface dark:text-slate-100 border border-surface-container-high dark:border-[#2E3440] focus:outline-none focus:ring-1 focus:ring-primary-container"
            />
            <button
              type="submit"
              disabled={savingName}
              className="h-10 px-3.5 rounded-lg bg-surface-container dark:bg-[#2A2D35] text-on-surface dark:text-slate-100 font-label-md text-label-md hover:bg-surface-container-high dark:hover:bg-[#343844] active:scale-95 transition-all shrink-0 disabled:opacity-50"
            >
              {savingName ? '儲存中' : '儲存'}
            </button>
          </div>
        </form>

        <div className="border-t border-surface-container-high/70 dark:border-white/[0.08]" />

        {/* Sync from Another Device */}
        <form onSubmit={handleBind} className="flex flex-col gap-2">
          <label className="text-label-md font-label-md text-on-surface dark:text-slate-200">
            輸入其他裝置的綁定碼以同步行程
          </label>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={bindInput}
              onChange={(e) => setBindInput(e.target.value.toUpperCase())}
              placeholder="TRIP-XXXX-XXXX"
              className="flex-1 min-w-0 h-10 px-3 rounded-lg bg-surface-container-low/60 dark:bg-[#14181F] font-mono text-body-md text-on-surface dark:text-slate-100 border border-surface-container-high dark:border-[#2E3440] focus:outline-none focus:ring-1 focus:ring-primary-container uppercase"
            />
            <button
              type="submit"
              disabled={binding}
              className="h-10 px-4 rounded-lg bg-primary-container text-on-primary font-label-md text-label-md shadow-sm hover:opacity-95 active:scale-95 transition-all shrink-0 disabled:opacity-50"
            >
              {binding ? '同步中' : '切換同步'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
