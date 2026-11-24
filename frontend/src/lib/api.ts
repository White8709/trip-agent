const DEVICE_TOKEN_KEY = 'trip_agent_device_token';

export type GuideStyle = 'cultural' | 'casual' | 'family';

export interface DeviceResponse {
  device_token: string;
  binding_code: string;
  display_name: string;
}

export interface DeviceProfile {
  binding_code: string;
  display_name: string;
  created_at: string;
}

export interface TripItem {
  item_id: number;
  sequence: number;
  start_time: string;
  name: string;
  duration_minutes: number;
  cached_styles: GuideStyle[];
}

export interface TripDay {
  day_number: number;
  date: string;
  items: TripItem[];
}

export interface Trip {
  id: string;
  title: string;
  share_url: string | null;
  created_at: string;
  days: TripDay[];
}

export interface WebSource {
  title: string;
  url: string;
}

export interface Guide {
  id: string;
  item_id: number;
  style: GuideStyle;
  story: string;
  highlights: string[];
  tips: string[];
  narration_script: string;
  audio_url: string | null;
  sources: WebSource[];
  updated_at: string;
}

export function getStoredDeviceToken(): string | null {
  return localStorage.getItem(DEVICE_TOKEN_KEY);
}

export function setStoredDeviceToken(token: string): void {
  localStorage.setItem(DEVICE_TOKEN_KEY, token);
}

async function requestJson<T>(
  path: string,
  options: RequestInit = {},
  includeAuth = true,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }

  if (includeAuth) {
    const token = getStoredDeviceToken();
    if (token) {
      headers.set('X-Device-Token', token);
    }
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      typeof data?.error === 'string' && data.error
        ? data.error
        : `請求失敗 (${res.status})`;
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }

  return data as T;
}

export async function registerDevice(): Promise<DeviceResponse> {
  const data = await requestJson<DeviceResponse>(
    '/api/devices/register',
    { method: 'POST' },
    false,
  );
  setStoredDeviceToken(data.device_token);
  return data;
}

export async function ensureDevice(): Promise<DeviceProfile> {
  const existingToken = getStoredDeviceToken();
  if (existingToken) {
    try {
      return await getMe();
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 401) {
        throw err;
      }
      localStorage.removeItem(DEVICE_TOKEN_KEY);
    }
  }

  const created = await registerDevice();
  return {
    binding_code: created.binding_code,
    display_name: created.display_name,
    created_at: new Date().toISOString(),
  };
}

export async function getMe(): Promise<DeviceProfile> {
  return requestJson<DeviceProfile>('/api/devices/me', { method: 'GET' });
}

export async function updateDisplayName(displayName: string): Promise<DeviceProfile> {
  return requestJson<DeviceProfile>('/api/devices/me', {
    method: 'PATCH',
    body: JSON.stringify({ display_name: displayName }),
  });
}

export async function bindDevice(bindingCode: string): Promise<DeviceResponse> {
  const data = await requestJson<DeviceResponse>(
    '/api/devices/bind',
    {
      method: 'POST',
      body: JSON.stringify({ binding_code: bindingCode }),
    },
    false,
  );
  setStoredDeviceToken(data.device_token);
  return data;
}

export async function importTrip(rawText: string): Promise<Trip> {
  return requestJson<Trip>('/api/trips/import', {
    method: 'POST',
    body: JSON.stringify({ raw_text: rawText }),
  });
}

export async function getLatestTrip(): Promise<Trip | null> {
  const res = await requestJson<{ trip: Trip | null }>('/api/trips/latest', {
    method: 'GET',
  });
  return res.trip;
}

export async function getGuide(itemId: number, style: GuideStyle): Promise<Guide | null> {
  const res = await requestJson<{ guide: Guide | null }>(
    `/api/items/${itemId}/guide?style=${encodeURIComponent(style)}`,
    { method: 'GET' },
  );
  return res.guide;
}

export async function generateGuide(
  itemId: number,
  style: GuideStyle,
  forceRegenerate = false,
): Promise<Guide> {
  const res = await requestJson<{ guide: Guide }>(`/api/items/${itemId}/guide`, {
    method: 'POST',
    body: JSON.stringify({ style, force_regenerate: forceRegenerate }),
  });
  return res.guide;
}

export async function generateGuideAudio(
  itemId: number,
  style: GuideStyle,
  forceRegenerate = false,
): Promise<string> {
  const res = await requestJson<{ audio_url: string }>(
    `/api/items/${itemId}/guide/audio`,
    {
      method: 'POST',
      body: JSON.stringify({ style, force_regenerate: forceRegenerate }),
    },
  );
  return res.audio_url;
}

export interface ChatMessage {
  role: 'user' | 'model';
  content: string;
  sources?: WebSource[];
  search_queries?: string[];
}

export interface ChatResponsePayload {
  reply: string;
  sources: WebSource[];
  search_queries: string[];
}

/**
 * Filter web sources to only valid HTTP(S) URLs with normalized fields.
 */
export function filterSafeWebSources(sources?: WebSource[]): WebSource[] {
  if (!Array.isArray(sources)) return [];
  return sources.reduce<WebSource[]>((acc, src) => {
    if (typeof src?.url !== 'string') return acc;
    const trimmedUrl = src.url.trim();
    if (!/^https?:\/\//i.test(trimmedUrl)) return acc;
    acc.push({
      title: typeof src.title === 'string' ? src.title.trim() : '',
      url: trimmedUrl,
    });
    return acc;
  }, []);
}

export async function getCapabilities(): Promise<{ web_search_enabled: boolean }> {
  const data = await requestJson<{ ok?: boolean; web_search_enabled?: boolean }>(
    '/api/health',
    { method: 'GET' },
    false,
  );
  return { web_search_enabled: Boolean(data?.web_search_enabled) };
}

export async function chatWithDay(
  tripId: string,
  dayNumber: number,
  messages: ChatMessage[],
  enableWebSearch = true,
): Promise<{ reply: string; sources: WebSource[]; search_queries: string[] }> {
  const res = await requestJson<Partial<ChatResponsePayload>>(
    `/api/trips/${encodeURIComponent(tripId)}/days/${dayNumber}/chat`,
    {
      method: 'POST',
      body: JSON.stringify({
        messages: messages.map(({ role, content }) => ({ role, content })),
        enable_web_search: enableWebSearch,
      }),
    },
  );
  return {
    reply: res.reply ?? '',
    sources: filterSafeWebSources(res.sources),
    search_queries: Array.isArray(res.search_queries) ? res.search_queries : [],
  };
}

export async function chatWithItem(
  itemId: number,
  messages: ChatMessage[],
  enableWebSearch = true,
): Promise<{ reply: string; sources: WebSource[]; search_queries: string[] }> {
  const res = await requestJson<Partial<ChatResponsePayload>>(`/api/items/${itemId}/chat`, {
    method: 'POST',
    body: JSON.stringify({
      messages: messages.map(({ role, content }) => ({ role, content })),
      enable_web_search: enableWebSearch,
    }),
  });
  return {
    reply: res.reply ?? '',
    sources: filterSafeWebSources(res.sources),
    search_queries: Array.isArray(res.search_queries) ? res.search_queries : [],
  };
}
