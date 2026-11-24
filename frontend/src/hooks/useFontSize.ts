import { useCallback, useEffect, useState } from 'react';

export type FontSizePreset = 'sm' | 'md' | 'lg' | 'xl';

export interface FontSizeOption {
  id: FontSizePreset;
  label: string;
  scale: number;
}

const FONT_SIZE_KEY = 'trip_agent_font_size';

export const FONT_SIZE_OPTIONS: FontSizeOption[] = [
  { id: 'sm', label: '小', scale: 0.9 },
  { id: 'md', label: '標準', scale: 1 },
  { id: 'lg', label: '大', scale: 1.15 },
  { id: 'xl', label: '特大', scale: 1.3 },
];

function isValidFontSizePreset(value: string | null): value is FontSizePreset {
  return FONT_SIZE_OPTIONS.some((opt) => opt.id === value);
}

/**
 * Manage the global 4-level font size scale CSS variable and persist it to localStorage.
 */
export function useFontSize() {
  const [fontSize, setFontSizeState] = useState<FontSizePreset>(() => {
    try {
      const stored = localStorage.getItem(FONT_SIZE_KEY);
      return isValidFontSizePreset(stored) ? stored : 'md';
    } catch {
      return 'md';
    }
  });

  const activeOption =
    FONT_SIZE_OPTIONS.find((opt) => opt.id === fontSize) ?? FONT_SIZE_OPTIONS[1];

  useEffect(() => {
    document.documentElement.style.setProperty('--font-scale', String(activeOption.scale));
    try {
      localStorage.setItem(FONT_SIZE_KEY, fontSize);
    } catch {
      // Ignore storage failures in restricted browsing contexts.
    }
  }, [fontSize, activeOption.scale]);

  const setFontSize = useCallback((nextSize: FontSizePreset) => {
    setFontSizeState(nextSize);
  }, []);

  const cycleFontSize = useCallback(() => {
    setFontSizeState((prev) => {
      const idx = FONT_SIZE_OPTIONS.findIndex((opt) => opt.id === prev);
      const nextIdx = (idx + 1) % FONT_SIZE_OPTIONS.length;
      return FONT_SIZE_OPTIONS[nextIdx].id;
    });
  }, []);

  return {
    fontSize,
    fontSizeLabel: activeOption.label,
    setFontSize,
    cycleFontSize,
    options: FONT_SIZE_OPTIONS,
  };
}
