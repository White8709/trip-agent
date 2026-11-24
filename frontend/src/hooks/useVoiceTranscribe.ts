import { useCallback, useEffect, useRef, useState } from 'react';
import { buildTranscribeWsUrl } from '../lib/api';

export type VoiceTranscribeState = 'idle' | 'connecting' | 'recording' | 'finishing';

export interface UseVoiceTranscribeOptions {
  onTranscriptUpdate: (transcript: string) => void;
  onError: (message: string) => void;
}

interface ServerTranscribeMessage {
  type?: string;
  text?: string;
  message?: string;
}

const TARGET_SAMPLE_RATE = 16000;
const CHUNK_SAMPLES = 3200; // 200ms at 16kHz -> 6400 bytes
const MAX_PRE_READY_SAMPLES = TARGET_SAMPLE_RATE * 3;
const READY_TIMEOUT_MS = 16000;
const FINISH_TIMEOUT_MS = 2500;

function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

function downsampleTo16kInt16(input: Float32Array, inputSampleRate: number): Int16Array {
  if (input.length === 0) return new Int16Array(0);

  if (inputSampleRate === TARGET_SAMPLE_RATE) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = floatToInt16(input[i]);
    }
    return out;
  }

  const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
  const outputLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(outputLength);

  if (ratio < 1) {
    // Upsample via linear interpolation if device sample rate is < 16kHz
    for (let i = 0; i < outputLength; i += 1) {
      const srcPos = i * ratio;
      const idx0 = Math.min(input.length - 1, Math.floor(srcPos));
      const idx1 = Math.min(input.length - 1, idx0 + 1);
      const frac = srcPos - idx0;
      const sample = input[idx0] * (1 - frac) + input[idx1] * frac;
      out[i] = floatToInt16(sample);
    }
    return out;
  }

  // Downsample via box averaging to reduce aliasing
  let offsetBuffer = 0;
  for (let i = 0; i < outputLength; i += 1) {
    const nextOffsetBuffer = Math.min(input.length, Math.round((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = offsetBuffer; j < nextOffsetBuffer; j += 1) {
      sum += input[j];
      count += 1;
    }
    const avg = count > 0 ? sum / count : input[Math.min(offsetBuffer, input.length - 1)];
    out[i] = floatToInt16(avg);
    offsetBuffer = nextOffsetBuffer;
  }
  return out;
}

function encodeInt16LittleEndian(samples: number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i], true);
  }
  return buffer;
}

function appendTranscriptSegment(acc: string, next: string): string {
  if (!next) return acc;
  if (!acc) return next;
  const lastChar = acc[acc.length - 1];
  const firstChar = next[0];
  if (/\s/.test(lastChar) || /\s/.test(firstChar)) {
    return acc + next;
  }
  if (/[A-Za-z0-9]/.test(lastChar) && /[A-Za-z0-9]/.test(firstChar)) {
    return `${acc} ${next}`;
  }
  return acc + next;
}

function joinTranscriptParts(finalSegments: string[], interimText: string): string {
  let combined = '';
  for (const seg of finalSegments) {
    combined = appendTranscriptSegment(combined, seg);
  }
  if (interimText) {
    combined = appendTranscriptSegment(combined, interimText);
  }
  return combined;
}

function describeMicError(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name?: unknown }).name);
    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return '麥克風權限被拒絕，請在瀏覽器設定中允許存取麥克風。';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return '找不到可用的麥克風裝置。';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return '麥克風目前正被其他應用程式使用中。';
    }
    if (name === 'NotSupportedError' || name === 'SecurityError') {
      return '目前連線環境不支援麥克風錄音，請使用 HTTPS 安全連線。';
    }
  }
  return err instanceof Error && err.message ? err.message : '無法啟動語音輸入，請稍後再試。';
}

export function useVoiceTranscribe({
  onTranscriptUpdate,
  onError,
}: UseVoiceTranscribeOptions) {
  const [state, setState] = useState<VoiceTranscribeState>('idle');

  const stateRef = useRef<VoiceTranscribeState>('idle');
  const mountedRef = useRef(true);
  const sessionIdRef = useRef(0);

  const onTranscriptUpdateRef = useRef(onTranscriptUpdate);
  const onErrorRef = useRef(onError);
  onTranscriptUpdateRef.current = onTranscriptUpdate;
  onErrorRef.current = onError;

  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const zeroGainRef = useRef<GainNode | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  const isReadyRef = useRef(false);
  const serverErrorHandledRef = useRef(false);
  const pcmQueueRef = useRef<number[]>([]);
  const finalSegmentsRef = useRef<string[]>([]);
  const interimTextRef = useRef('');

  const readyTimerRef = useRef<number | null>(null);
  const finishTimerRef = useRef<number | null>(null);

  const updateState = useCallback((next: VoiceTranscribeState) => {
    stateRef.current = next;
    if (mountedRef.current) {
      setState(next);
    }
  }, []);

  const clearTimers = useCallback(() => {
    if (readyTimerRef.current !== null) {
      window.clearTimeout(readyTimerRef.current);
      readyTimerRef.current = null;
    }
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const stopAudioCapture = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null;
      try {
        processorRef.current.disconnect();
      } catch {
        // Ignore disconnect errors during teardown
      }
      processorRef.current = null;
    }
    if (sourceRef.current) {
      try {
        sourceRef.current.disconnect();
      } catch {
        // Ignore disconnect errors during teardown
      }
      sourceRef.current = null;
    }
    if (zeroGainRef.current) {
      try {
        zeroGainRef.current.disconnect();
      } catch {
        // Ignore disconnect errors during teardown
      }
      zeroGainRef.current = null;
    }
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      const ctx = audioCtxRef.current;
      audioCtxRef.current = null;
      void ctx.close().catch(() => {});
    }
  }, []);

  const closeWebSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close(1000, 'client cleanup');
      } catch {
        // Ignore close errors
      }
    }
  }, []);

  const cleanupResources = useCallback(() => {
    clearTimers();
    stopAudioCapture();
    closeWebSocket();
    isReadyRef.current = false;
    pcmQueueRef.current = [];
  }, [clearTimers, closeWebSocket, stopAudioCapture]);

  const finishToIdle = useCallback(() => {
    sessionIdRef.current += 1;
    cleanupResources();
    updateState('idle');
  }, [cleanupResources, updateState]);

  const emitTranscript = useCallback(() => {
    const text = joinTranscriptParts(finalSegmentsRef.current, interimTextRef.current);
    onTranscriptUpdateRef.current(text);
  }, []);

  const promoteInterimIfAny = useCallback(() => {
    if (interimTextRef.current.trim()) {
      finalSegmentsRef.current.push(interimTextRef.current);
      interimTextRef.current = '';
      emitTranscript();
    }
  }, [emitTranscript]);

  const flushPcmQueue = useCallback((flushAll: boolean) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !isReadyRef.current) return;

    while (pcmQueueRef.current.length >= CHUNK_SAMPLES) {
      const chunk = pcmQueueRef.current.splice(0, CHUNK_SAMPLES);
      ws.send(encodeInt16LittleEndian(chunk));
    }

    if (flushAll && pcmQueueRef.current.length > 0) {
      const remainder = pcmQueueRef.current.splice(0, pcmQueueRef.current.length);
      ws.send(encodeInt16LittleEndian(remainder));
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionIdRef.current += 1;
      cleanupResources();
    };
  }, [cleanupResources]);

  const start = useCallback(async () => {
    if (stateRef.current !== 'idle') return;

    if (!navigator.mediaDevices?.getUserMedia) {
      onErrorRef.current(
        '目前瀏覽器或非 HTTPS 連線環境不支援麥克風錄音，請使用 HTTPS 或支援錄音的瀏覽器。',
      );
      return;
    }

    let wsUrl: string;
    try {
      wsUrl = buildTranscribeWsUrl();
    } catch (err) {
      onErrorRef.current(
        err instanceof Error ? err.message : '找不到裝置憑證，無法啟用語音輸入。',
      );
      return;
    }

    const mySessionId = sessionIdRef.current + 1;
    sessionIdRef.current = mySessionId;

    isReadyRef.current = false;
    serverErrorHandledRef.current = false;
    pcmQueueRef.current = [];
    finalSegmentsRef.current = [];
    interimTextRef.current = '';
    updateState('connecting');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      if (!mountedRef.current || sessionIdRef.current !== mySessionId) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      streamRef.current = stream;

      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('此瀏覽器不支援 Web Audio API，無法進行語音輸入。');
      }

      const audioCtx = new AudioCtx();
      audioCtxRef.current = audioCtx;
      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      if (!mountedRef.current || sessionIdRef.current !== mySessionId) {
        stopAudioCapture();
        return;
      }

      const source = audioCtx.createMediaStreamSource(stream);
      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      const zeroGain = audioCtx.createGain();
      zeroGain.gain.value = 0;

      sourceRef.current = source;
      processorRef.current = processor;
      zeroGainRef.current = zeroGain;

      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        if (sessionIdRef.current !== mySessionId) return;
        const currentState = stateRef.current;
        if (currentState !== 'connecting' && currentState !== 'recording') return;

        const inputChannel = event.inputBuffer.getChannelData(0);
        const int16 = downsampleTo16kInt16(inputChannel, audioCtx.sampleRate);
        if (int16.length === 0) return;

        const queue = pcmQueueRef.current;
        for (let i = 0; i < int16.length; i += 1) {
          queue.push(int16[i]);
        }

        if (!isReadyRef.current) {
          if (queue.length > MAX_PRE_READY_SAMPLES) {
            queue.splice(0, queue.length - MAX_PRE_READY_SAMPLES);
          }
          return;
        }

        flushPcmQueue(false);
      };

      source.connect(processor);
      processor.connect(zeroGain);
      zeroGain.connect(audioCtx.destination);

      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      readyTimerRef.current = window.setTimeout(() => {
        if (sessionIdRef.current !== mySessionId) return;
        if (stateRef.current === 'connecting') {
          serverErrorHandledRef.current = true;
          onErrorRef.current('語音辨識連線逾時，請稍後再試。');
          finishToIdle();
        }
      }, READY_TIMEOUT_MS);

      ws.onmessage = (event: MessageEvent) => {
        if (sessionIdRef.current !== mySessionId) return;

        let rawText = '';
        if (typeof event.data === 'string') {
          rawText = event.data;
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data);
        } else {
          return;
        }

        let payload: ServerTranscribeMessage;
        try {
          payload = JSON.parse(rawText) as ServerTranscribeMessage;
        } catch {
          return;
        }

        switch (payload.type) {
          case 'ready': {
            if (readyTimerRef.current !== null) {
              window.clearTimeout(readyTimerRef.current);
              readyTimerRef.current = null;
            }
            if (stateRef.current !== 'connecting') return;
            isReadyRef.current = true;
            updateState('recording');
            flushPcmQueue(false);
            break;
          }
          case 'interim': {
            interimTextRef.current = typeof payload.text === 'string' ? payload.text : '';
            emitTranscript();
            break;
          }
          case 'final': {
            if (typeof payload.text === 'string' && payload.text.trim()) {
              finalSegmentsRef.current.push(payload.text);
            }
            interimTextRef.current = '';
            emitTranscript();
            break;
          }
          case 'done': {
            promoteInterimIfAny();
            if (stateRef.current === 'finishing') {
              finishToIdle();
            }
            break;
          }
          case 'error': {
            serverErrorHandledRef.current = true;
            onErrorRef.current(
              typeof payload.message === 'string' && payload.message.trim()
                ? payload.message
                : '語音辨識服務發生錯誤，請稍後再試。',
            );
            finishToIdle();
            break;
          }
          default:
            break;
        }
      };

      ws.onerror = () => {
        if (sessionIdRef.current !== mySessionId) return;
        if (!serverErrorHandledRef.current && stateRef.current !== 'finishing') {
          serverErrorHandledRef.current = true;
          onErrorRef.current('語音辨識 WebSocket 連線失敗，請稍後再試。');
        }
      };

      ws.onclose = (event: CloseEvent) => {
        if (sessionIdRef.current !== mySessionId) return;
        const currentState = stateRef.current;
        if (currentState === 'finishing') {
          promoteInterimIfAny();
          finishToIdle();
          return;
        }
        if (currentState === 'connecting' || currentState === 'recording') {
          if (!serverErrorHandledRef.current && !event.wasClean) {
            onErrorRef.current('語音辨識連線已中斷，請再試一次。');
          } else if (currentState === 'connecting' && !serverErrorHandledRef.current) {
            onErrorRef.current('無法連線至語音辨識服務，請確認登入狀態或稍後再試。');
          }
          promoteInterimIfAny();
          finishToIdle();
        }
      };
    } catch (err) {
      if (!mountedRef.current || sessionIdRef.current !== mySessionId) {
        cleanupResources();
        return;
      }
      cleanupResources();
      updateState('idle');
      onErrorRef.current(describeMicError(err));
    }
  }, [
    cleanupResources,
    emitTranscript,
    finishToIdle,
    flushPcmQueue,
    promoteInterimIfAny,
    stopAudioCapture,
    updateState,
  ]);

  const stop = useCallback(() => {
    const currentState = stateRef.current;
    if (currentState === 'idle' || currentState === 'finishing') return;

    clearTimers();
    stopAudioCapture();

    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && isReadyRef.current) {
      flushPcmQueue(true);
      try {
        ws.send(JSON.stringify({ type: 'end' }));
      } catch {
        finishToIdle();
        return;
      }
      updateState('finishing');
      finishTimerRef.current = window.setTimeout(() => {
        promoteInterimIfAny();
        finishToIdle();
      }, FINISH_TIMEOUT_MS);
      return;
    }

    finishToIdle();
  }, [clearTimers, finishToIdle, flushPcmQueue, promoteInterimIfAny, stopAudioCapture, updateState]);

  return {
    state,
    start,
    stop,
  };
}
