import { useCallback, useEffect, useState } from 'react';
import { AiGuideSheet } from './components/AiGuideSheet';
import { DeviceModal } from './components/DeviceModal';
import { useFontSize } from './hooks/useFontSize';
import { useTheme } from './hooks/useTheme';
import {
  bindDevice,
  DeviceProfile,
  ensureDevice,
  getCapabilities,
  getLatestTrip,
  GuideStyle,
  Trip,
  TripItem,
  updateDisplayName,
} from './lib/api';
import { ImportPage } from './pages/ImportPage';
import { TimelinePage } from './pages/TimelinePage';

type ViewMode = 'timeline' | 'import';

export function App() {
  const { isDark, toggleTheme } = useTheme();
  const { fontSize, fontSizeLabel, setFontSize, cycleFontSize } = useFontSize();
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [view, setView] = useState<ViewMode>('import');
  const [selectedItem, setSelectedItem] = useState<TripItem | null>(null);
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    setBootError(null);
    try {
      const dev = await ensureDevice();
      setProfile(dev);
      const [latest, caps] = await Promise.all([
        getLatestTrip(),
        getCapabilities().catch(() => ({ web_search_enabled: false })),
      ]);
      setTrip(latest);
      setWebSearchAvailable(caps.web_search_enabled);
      setView(latest ? 'timeline' : 'import');
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : '無法連線至後端伺服器，請確認服務是否已啟動。',
      );
    } finally {
      setBootstrapping(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleImported = (newTrip: Trip) => {
    setTrip(newTrip);
    setView('timeline');
  };

  const handleUpdateDeviceName = async (displayName: string) => {
    const updated = await updateDisplayName(displayName);
    setProfile(updated);
  };

  const handleBindCode = async (code: string) => {
    const bound = await bindDevice(code);
    setProfile({
      binding_code: bound.binding_code,
      display_name: bound.display_name,
      created_at: new Date().toISOString(),
    });
    const latest = await getLatestTrip();
    setTrip(latest);
    setSelectedItem(null);
    setView(latest ? 'timeline' : 'import');
  };

  const handleStyleCached = useCallback((itemId: number, style: GuideStyle) => {
    setTrip((prev) => {
      if (!prev) return prev;
      let changed = false;
      const days = prev.days.map((day) => ({
        ...day,
        items: day.items.map((item) => {
          if (item.item_id !== itemId) return item;
          if (item.cached_styles.includes(style)) return item;
          changed = true;
          return {
            ...item,
            cached_styles: [...item.cached_styles, style],
          };
        }),
      }));
      return changed ? { ...prev, days } : prev;
    });
    setSelectedItem((prev) => {
      if (!prev || prev.item_id !== itemId) return prev;
      if (prev.cached_styles.includes(style)) return prev;
      return { ...prev, cached_styles: [...prev.cached_styles, style] };
    });
  }, []);

  if (bootstrapping) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface dark:bg-[#121316] text-on-surface dark:text-[#E2E8F0] gap-3 px-4">
        <span className="material-symbols-outlined text-[32px] text-primary dark:text-[#ff8a70] animate-spin">
          progress_activity
        </span>
        <p className="text-body-md font-body-md text-on-surface-variant dark:text-slate-400">
          正在初始化旅行手帳...
        </p>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-surface dark:bg-[#121316] text-on-surface dark:text-[#E2E8F0] px-6 text-center gap-4">
        <div className="w-12 h-12 rounded-full bg-error-container dark:bg-rose-950/60 text-error dark:text-rose-300 flex items-center justify-center">
          <span className="material-symbols-outlined text-[24px]">cloud_off</span>
        </div>
        <div className="max-w-[340px] sm:max-w-md flex flex-col gap-1">
          <h1 className="font-headline-sm text-headline-sm">連線失敗</h1>
          <p className="text-body-sm text-on-surface-variant dark:text-slate-400">{bootError}</p>
        </div>
        <button
          type="button"
          onClick={() => void bootstrap()}
          className="h-11 px-5 rounded-xl bg-primary-container text-on-primary font-label-md text-label-md shadow-md active:scale-95 transition-transform"
        >
          重新連線
        </button>
      </div>
    );
  }

  return (
    <>
      {view === 'timeline' && trip ? (
        <TimelinePage
          trip={trip}
          isDark={isDark}
          webSearchAvailable={webSearchAvailable}
          activeGuideItemId={selectedItem?.item_id ?? null}
          onToggleTheme={toggleTheme}
          onOpenDeviceModal={() => setDeviceModalOpen(true)}
          onSelectGuide={(item) => setSelectedItem(item)}
          renderGuidePanel={(currentDayItems) => (
            <AiGuideSheet
              item={selectedItem}
              webSearchAvailable={webSearchAvailable}
              fontSizeLabel={fontSizeLabel}
              onCycleFontSize={cycleFontSize}
              onClose={() => setSelectedItem(null)}
              onStyleCached={handleStyleCached}
              quickPickItems={currentDayItems}
              onSelectQuickItem={(item) => setSelectedItem(item)}
            />
          )}
        />
      ) : (
        <ImportPage
          canGoBack={trip !== null}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onOpenDeviceModal={() => setDeviceModalOpen(true)}
          onBack={() => setView('timeline')}
          onImported={handleImported}
        />
      )}

      <DeviceModal
        isOpen={deviceModalOpen}
        profile={profile}
        fontSize={fontSize}
        onChangeFontSize={setFontSize}
        onClose={() => setDeviceModalOpen(false)}
        onOpenImport={() => {
          setDeviceModalOpen(false);
          setSelectedItem(null);
          setView('import');
        }}
        onUpdateName={handleUpdateDeviceName}
        onBindCode={handleBindCode}
      />
    </>
  );
}

export default App;
