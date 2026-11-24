import { useCallback, useEffect, useRef, useState } from 'react';
import { AiGuideSheet } from './components/AiGuideSheet';
import { DeviceModal } from './components/DeviceModal';
import { useFontSize } from './hooks/useFontSize';
import { useTheme } from './hooks/useTheme';
import {
  bindDevice,
  deleteTrip,
  DeviceProfile,
  ensureDevice,
  getCapabilities,
  getLastTripId,
  getLatestTrip,
  getTrip,
  GuideStyle,
  listTrips,
  setLastTripId,
  Trip,
  TripItem,
  TripSummary,
  updateDisplayName,
  UpdateTripResult,
} from './lib/api';
import { ImportPage } from './pages/ImportPage';
import { TimelinePage } from './pages/TimelinePage';
import { TripListPage } from './pages/TripListPage';

type ViewMode = 'trips' | 'timeline' | 'import';

interface LocationState {
  view: 'trips' | 'timeline' | 'import' | 'default';
  tripId: string | null;
  updateId: string | null;
}

function parseLocation(): LocationState {
  const params = new URLSearchParams(window.location.search);
  const view = params.get('view');
  const tripId = params.get('trip');
  if (view === 'import') {
    return { view: 'import', tripId: null, updateId: params.get('update') };
  }
  if (view === 'trips') return { view: 'trips', tripId: null, updateId: null };
  if (tripId) return { view: 'timeline', tripId, updateId: null };
  return { view: 'default', tripId: null, updateId: null };
}

function buildUrl(view: ViewMode, tripId?: string | null, updateId?: string | null): string {
  const params = new URLSearchParams();
  if (view === 'trips') params.set('view', 'trips');
  else if (view === 'import') {
    params.set('view', 'import');
    if (updateId) params.set('update', updateId);
  } else if (tripId) params.set('trip', tripId);
  const qs = params.toString();
  return `${window.location.pathname}${qs ? `?${qs}` : ''}`;
}

function syncUrl(url: string, mode: 'push' | 'replace') {
  const current = `${window.location.pathname}${window.location.search}`;
  if (mode === 'push' && current === url) return;
  if (mode === 'push') window.history.pushState(null, '', url);
  else window.history.replaceState(null, '', url);
}

export function App() {
  const { isDark, toggleTheme } = useTheme();
  const { fontSize, fontSizeLabel, setFontSize, cycleFontSize } = useFontSize();
  const [bootstrapping, setBootstrapping] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [profile, setProfile] = useState<DeviceProfile | null>(null);
  const [tripSummaries, setTripSummaries] = useState<TripSummary[]>([]);
  const [trip, setTrip] = useState<Trip | null>(null);
  const [updatingTrip, setUpdatingTrip] = useState<Trip | null>(null);
  const [switchingTrip, setSwitchingTrip] = useState(false);
  const [toastNotice, setToastNotice] = useState<string | null>(null);
  const [webSearchAvailable, setWebSearchAvailable] = useState(false);
  const [view, setView] = useState<ViewMode>('import');
  const [importReturn, setImportReturn] = useState<'trips' | 'timeline'>('trips');
  const [selectedItem, setSelectedItem] = useState<TripItem | null>(null);
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);

  const summariesRef = useRef<TripSummary[]>([]);
  const tripRef = useRef<Trip | null>(null);
  const readyRef = useRef(false);
  summariesRef.current = tripSummaries;
  tripRef.current = trip;

  useEffect(() => {
    if (!toastNotice) return;
    const timer = window.setTimeout(() => setToastNotice(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toastNotice]);

  const refreshSummaries = useCallback(async (): Promise<TripSummary[]> => {
    try {
      const list = await listTrips();
      setTripSummaries(list);
      summariesRef.current = list;
      return list;
    } catch {
      return summariesRef.current;
    }
  }, []);

  const showTrip = useCallback((next: Trip) => {
    setTrip(next);
    tripRef.current = next;
    setLastTripId(next.id);
    setSelectedItem(null);
    setUpdatingTrip(null);
    setView('timeline');
  }, []);

  /** Fetch a trip by id, falling back to latest / first summary when missing. */
  const loadTripWithFallback = useCallback(
    async (preferredId: string | null, summaries: TripSummary[]): Promise<Trip | null> => {
      if (preferredId) {
        try {
          return await getTrip(preferredId);
        } catch (err) {
          const status = (err as { status?: number }).status;
          if (status && status !== 404 && status !== 400) throw err;
        }
      }
      try {
        const latest = await getLatestTrip();
        if (latest) return latest;
      } catch {
        // fall through to first summary
      }
      if (summaries[0]) return getTrip(summaries[0].id);
      return null;
    },
    [],
  );

  /** Resolve the current URL into view state. */
  const applyLocation = useCallback(
    async (summaries: TripSummary[], urlMode: 'replace' | 'push' = 'replace') => {
      const loc = parseLocation();
      if (summaries.length === 0) {
        setTrip(null);
        setUpdatingTrip(null);
        setView('import');
        syncUrl(buildUrl('import'), 'replace');
        return;
      }

      if (loc.view === 'trips') {
        setUpdatingTrip(null);
        setView('trips');
        return;
      }

      if (loc.view === 'import') {
        if (loc.updateId) {
          try {
            const target = await getTrip(loc.updateId);
            setUpdatingTrip(target);
            setImportReturn('trips');
            setView('import');
            return;
          } catch {
            setUpdatingTrip(null);
            setView('trips');
            syncUrl(buildUrl('trips'), 'replace');
            return;
          }
        }
        setUpdatingTrip(null);
        setImportReturn(tripRef.current ? 'timeline' : 'trips');
        setView('import');
        return;
      }

      const preferred = loc.tripId ?? getLastTripId();
      if (tripRef.current && preferred === tripRef.current.id) {
        showTrip(tripRef.current);
        return;
      }
      const resolved = await loadTripWithFallback(preferred, summaries);
      if (!resolved) {
        setView('import');
        syncUrl(buildUrl('import'), 'replace');
        return;
      }
      showTrip(resolved);
      syncUrl(buildUrl('timeline', resolved.id), urlMode);
    },
    [loadTripWithFallback, showTrip],
  );

  const bootstrap = useCallback(async () => {
    setBootstrapping(true);
    setBootError(null);
    try {
      const dev = await ensureDevice();
      setProfile(dev);
      const [summaries, caps] = await Promise.all([
        listTrips(),
        getCapabilities().catch(() => ({ web_search_enabled: false })),
      ]);
      setTripSummaries(summaries);
      summariesRef.current = summaries;
      setWebSearchAvailable(caps.web_search_enabled);
      await applyLocation(summaries, 'replace');
      readyRef.current = true;
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : '無法連線至後端伺服器，請確認服務是否已啟動。',
      );
    } finally {
      setBootstrapping(false);
    }
  }, [applyLocation]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    const onPopState = () => {
      if (!readyRef.current) return;
      setSelectedItem(null);
      setDeviceModalOpen(false);
      setSwitchingTrip(true);
      applyLocation(summariesRef.current)
        .catch((err) => {
          setToastNotice(err instanceof Error ? err.message : '載入行程失敗');
        })
        .finally(() => setSwitchingTrip(false));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyLocation]);

  const goToTripList = useCallback(() => {
    setSelectedItem(null);
    setUpdatingTrip(null);
    setView('trips');
    syncUrl(buildUrl('trips'), 'push');
  }, []);

  const openTrip = useCallback(
    async (tripId: string) => {
      setSelectedItem(null);
      if (tripRef.current && tripRef.current.id === tripId) {
        showTrip(tripRef.current);
        syncUrl(buildUrl('timeline', tripId), 'push');
        return;
      }
      setSwitchingTrip(true);
      try {
        const next = await getTrip(tripId);
        showTrip(next);
        syncUrl(buildUrl('timeline', next.id), 'push');
      } catch (err) {
        setToastNotice(err instanceof Error ? err.message : '載入行程失敗');
        void refreshSummaries();
      } finally {
        setSwitchingTrip(false);
      }
    },
    [refreshSummaries, showTrip],
  );

  const openImportNew = useCallback(() => {
    setSelectedItem(null);
    setUpdatingTrip(null);
    setImportReturn(view === 'timeline' && tripRef.current ? 'timeline' : 'trips');
    setView('import');
    syncUrl(buildUrl('import'), 'push');
  }, [view]);

  const openUpdate = useCallback(
    async (tripId: string) => {
      setSwitchingTrip(true);
      try {
        const target = await getTrip(tripId);
        setSelectedItem(null);
        setUpdatingTrip(target);
        setImportReturn(view === 'timeline' ? 'timeline' : 'trips');
        setView('import');
        syncUrl(buildUrl('import', null, tripId), 'push');
      } catch (err) {
        setToastNotice(err instanceof Error ? err.message : '載入行程失敗');
      } finally {
        setSwitchingTrip(false);
      }
    },
    [view],
  );

  const handleImportBack = useCallback(() => {
    if (importReturn === 'timeline' && tripRef.current) {
      setUpdatingTrip(null);
      setView('timeline');
      syncUrl(buildUrl('timeline', tripRef.current.id), 'push');
    } else {
      goToTripList();
    }
  }, [goToTripList, importReturn]);

  const handleImported = (newTrip: Trip) => {
    showTrip(newTrip);
    syncUrl(buildUrl('timeline', newTrip.id), 'replace');
    void refreshSummaries();
  };

  const handleUpdated = (result: UpdateTripResult) => {
    showTrip(result.trip);
    syncUrl(buildUrl('timeline', result.trip.id), 'replace');
    setToastNotice(`已更新「${result.trip.title}」，保留 ${result.preserved_guides} 筆 AI 導覽快取`);
    void refreshSummaries();
  };

  const handleDeleteTrip = async (tripId: string) => {
    const target = summariesRef.current.find((t) => t.id === tripId);
    await deleteTrip(tripId);
    if (getLastTripId() === tripId) setLastTripId(null);
    if (tripRef.current?.id === tripId) {
      setTrip(null);
      tripRef.current = null;
      setSelectedItem(null);
    }
    const remaining = summariesRef.current.filter((t) => t.id !== tripId);
    setTripSummaries(remaining);
    summariesRef.current = remaining;
    setToastNotice(`已刪除「${target?.title ?? '行程'}」`);
    const fresh = await refreshSummaries();
    if (fresh.length === 0) {
      setTrip(null);
      setUpdatingTrip(null);
      setView('import');
      syncUrl(buildUrl('import'), 'replace');
    }
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
    setLastTripId(null);
    setTrip(null);
    tripRef.current = null;
    setUpdatingTrip(null);
    setSelectedItem(null);
    const list = await listTrips();
    setTripSummaries(list);
    summariesRef.current = list;
    if (list.length === 0) {
      setView('import');
      syncUrl(buildUrl('import'), 'replace');
      return;
    }
    const latest = await loadTripWithFallback(null, list);
    if (latest) {
      showTrip(latest);
      syncUrl(buildUrl('timeline', latest.id), 'replace');
    } else {
      setView('trips');
      syncUrl(buildUrl('trips'), 'replace');
    }
  };

  const handleStyleCached = useCallback((itemId: number, style: GuideStyle) => {
    const current = tripRef.current;
    if (current) {
      const target = current.days.flatMap((d) => d.items).find((i) => i.item_id === itemId);
      if (target && target.cached_styles.length === 0) {
        setTripSummaries((prev) =>
          prev.map((t) =>
            t.id === current.id
              ? { ...t, cached_guide_item_count: Math.min(t.item_count, t.cached_guide_item_count + 1) }
              : t,
          ),
        );
      }
    }
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
      {view === 'trips' ? (
        <TripListPage
          trips={tripSummaries}
          activeTripId={trip?.id ?? getLastTripId()}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onOpenDeviceModal={() => setDeviceModalOpen(true)}
          onOpenTrip={(id) => void openTrip(id)}
          onOpenImportNew={openImportNew}
          onUpdateTrip={(id) => void openUpdate(id)}
          onDeleteTrip={handleDeleteTrip}
        />
      ) : view === 'timeline' && trip ? (
        <TimelinePage
          trip={trip}
          trips={tripSummaries}
          switchingTrip={switchingTrip}
          onOpenTripList={goToTripList}
          onSwitchTrip={(id) => void openTrip(id)}
          onOpenImportNew={openImportNew}
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
          key={updatingTrip?.id ?? 'new'}
          canGoBack={tripSummaries.length > 0}
          isDark={isDark}
          onToggleTheme={toggleTheme}
          onOpenDeviceModal={() => setDeviceModalOpen(true)}
          onBack={handleImportBack}
          onImported={handleImported}
          existingTrips={tripSummaries}
          updatingTrip={updatingTrip}
          onUpdated={handleUpdated}
        />
      )}

      <DeviceModal
        isOpen={deviceModalOpen}
        profile={profile}
        fontSize={fontSize}
        onChangeFontSize={setFontSize}
        onClose={() => setDeviceModalOpen(false)}
        tripCount={tripSummaries.length}
        canUpdateCurrentTrip={view === 'timeline' && trip !== null}
        onOpenTripList={() => {
          setDeviceModalOpen(false);
          goToTripList();
        }}
        onUpdateCurrentTrip={() => {
          setDeviceModalOpen(false);
          if (trip) void openUpdate(trip.id);
        }}
        onOpenImport={() => {
          setDeviceModalOpen(false);
          openImportNew();
        }}
        onUpdateName={handleUpdateDeviceName}
        onBindCode={handleBindCode}
      />

      {switchingTrip && (
        <div className="fixed inset-0 z-[55] flex items-center justify-center bg-black/20 backdrop-blur-[1px]">
          <div className="w-12 h-12 rounded-full bg-surface dark:bg-[#1c1f26] shadow-lg flex items-center justify-center">
            <span className="material-symbols-outlined text-[26px] text-primary dark:text-[#ff8a70] animate-spin">
              progress_activity
            </span>
          </div>
        </div>
      )}

      {toastNotice && (
        <div
          role="status"
          aria-live="polite"
          className="fixed bottom-6 inset-x-0 z-[70] flex justify-center px-4 pointer-events-none pb-safe"
        >
          <div className="pointer-events-auto max-w-[480px] w-full sm:w-auto flex items-center gap-2.5 px-4 py-3 rounded-xl bg-[#2f3033] dark:bg-[#e2e8f0] text-white dark:text-[#121316] shadow-xl text-body-sm font-body-sm">
            <span className="material-symbols-outlined text-[18px] shrink-0 text-[#88d982] dark:text-[#238636]">
              check_circle
            </span>
            <span className="min-w-0 break-words">{toastNotice}</span>
            <button
              type="button"
              onClick={() => setToastNotice(null)}
              aria-label="關閉通知"
              className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center hover:bg-white/10 dark:hover:bg-black/10"
            >
              <span className="material-symbols-outlined text-[16px]">close</span>
            </button>
          </div>
        </div>
      )}
    </>
  );
}

export default App;
