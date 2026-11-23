export interface PreviewItem {
  sequence: number;
  start_time: string;
  name: string;
  duration_minutes: number;
}

export interface PreviewDay {
  day_number: number;
  date: string;
  items: PreviewItem[];
}

export interface ParsedPreview {
  title: string;
  share_url: string | null;
  days: PreviewDay[];
  totalItems: number;
  totalDurationMinutes: number;
  dateRangeText: string;
}

export type PreviewParseResult =
  | { ok: true; data: ParsedPreview }
  | { ok: false; error: string };

const TITLE_RE = /^行程名稱[：:]\s*(.+)$/;
const DAY_RE = /^第(\d+)天\s*\((\d{4})\/(\d{1,2})\/(\d{1,2})\)$/;
const ITEM_RE = /^(\d{2}:\d{2})\s+(.+?)\s*\(停留\s*(\d{2})時(\d{2})分\)$/;
const SHARE_URL_RE = /https:\/\/chictrip-share\.app\.link\/\S+/;

export const SAMPLE_CHICTRIP_TEXT = `行程名稱：2026大阪秋季漫遊
第1天 (2026/11/26)
11:10 關西國際機場 (停留 01時30分)
13:30 難波站(寄放行李) (停留 00時30分)
14:30 心齋橋筋商店街 (停留 02時00分)
16:45 中村藤吉本店 難波站前 (停留 00時00分)
18:00 道頓堀 美食巡禮 (停留 02時30分)
第2天 (2026/11/27)
09:00 大阪城天守閣 (停留 02時00分)
12:00 黑門市場 (停留 01時30分)
15:00 梅田藍天大廈（空中庭園） (停留 02時00分)
https://chictrip-share.app.link/3IwOCi6077b`;

export function parseChicTripPreview(rawText: string): PreviewParseResult {
  if (!rawText.trim()) {
    return { ok: false, error: '請貼上去趣匯出的純文字行程內容。' };
  }

  let title: string | null = null;
  let shareUrl: string | null = null;
  const days: PreviewDay[] = [];

  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const titleMatch = line.match(TITLE_RE);
    if (titleMatch) {
      const parsedTitle = titleMatch[1].trim();
      if (parsedTitle) {
        title = parsedTitle;
      }
      continue;
    }

    const dayMatch = line.match(DAY_RE);
    if (dayMatch) {
      const dayNumber = Number.parseInt(dayMatch[1], 10);
      const year = Number.parseInt(dayMatch[2], 10);
      const month = Number.parseInt(dayMatch[3], 10);
      const day = Number.parseInt(dayMatch[4], 10);
      if (month < 1 || month > 12 || day < 1 || day > 31) {
        return { ok: false, error: `日期格式無效：${line}` };
      }
      const isoDate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      days.push({
        day_number: dayNumber,
        date: isoDate,
        items: [],
      });
      continue;
    }

    const itemMatch = line.match(ITEM_RE);
    if (itemMatch) {
      const currentDay = days[days.length - 1];
      if (!currentDay) {
        return {
          ok: false,
          error: `第 ${i + 1} 行在「第N天 (YYYY/MM/DD)」標頭前出現了景點項目。`,
        };
      }
      const startTime = itemMatch[1];
      const name = itemMatch[2].trim();
      const hours = Number.parseInt(itemMatch[3], 10);
      const mins = Number.parseInt(itemMatch[4], 10);
      const durationMinutes = hours * 60 + mins;
      currentDay.items.push({
        sequence: currentDay.items.length + 1,
        start_time: startTime,
        name,
        duration_minutes: durationMinutes,
      });
      continue;
    }

    if (!shareUrl) {
      const urlMatch = line.match(SHARE_URL_RE);
      if (urlMatch) {
        shareUrl = urlMatch[0];
      }
    }
  }

  if (!title) {
    return { ok: false, error: '找不到行程標題（格式：行程名稱：<標題>）。' };
  }

  days.sort((a, b) => a.day_number - b.day_number);
  let totalItems = 0;
  let totalDurationMinutes = 0;
  for (const d of days) {
    d.items.sort((a, b) => a.sequence - b.sequence);
    totalItems += d.items.length;
    for (const item of d.items) {
      totalDurationMinutes += item.duration_minutes;
    }
  }

  if (days.length === 0 || totalItems === 0) {
    return {
      ok: false,
      error: '尚未偵測到任何「第N天 (YYYY/MM/DD)」與景點節點。',
    };
  }

  const firstDate = days[0].date.replace(/-/g, '/');
  const lastDate = days[days.length - 1].date;
  const dateRangeText =
    days.length === 1
      ? firstDate
      : `${firstDate} - ${lastDate.slice(5).replace(/-/g, '/')}`;

  return {
    ok: true,
    data: {
      title,
      share_url: shareUrl,
      days,
      totalItems,
      totalDurationMinutes,
      dateRangeText,
    },
  };
}

export function formatStayDuration(minutes: number): string {
  if (minutes === 0) {
    return '路過 / 備案 (0分)';
  }
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `停留 ${h}小時${m}分`;
  if (h > 0) return `停留 ${h}小時`;
  return `停留 ${m}分`;
}

export function formatTotalStay(minutes: number): string {
  if (minutes === 0) return '彈性停留';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h > 0 && m > 0) return `${h} 小時 ${m} 分`;
  if (h > 0) return `${h} 小時`;
  return `${m} 分鐘`;
}

export function formatDateWithWeekday(isoDate: string): string {
  const parts = isoDate.split('-').map((n) => Number.parseInt(n, 10));
  if (parts.length !== 3 || parts.some(Number.isNaN)) return isoDate;
  const [y, m, d] = parts;
  const dateObj = new Date(y, m - 1, d);
  const weekdays = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
  const wd = weekdays[dateObj.getDay()] ?? '';
  return `${String(y).padStart(4, '0')}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')} (${wd})`;
}

export function formatShortMonthDay(isoDate: string): string {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[1]}/${parts[2]}`;
}
