import { useCallback, useEffect, useRef, useState } from 'react';
import { convertToWav } from '@/lib/wav';

export type RecorderStatus = 'idle' | 'requesting' | 'recording' | 'processing' | 'error';

interface UseRecorderOptions {
  /** 最长录制秒数，到时自动停止 */
  maxSeconds?: number;
}

/**
 * 麦克风录制。浏览器录音必须在安全上下文（HTTPS 或 localhost）下才能使用。
 * 录制结果统一转码为 24kHz 单声道 WAV。
 */
export function useRecorder(options: UseRecorderOptions = {}) {
  const { maxSeconds = 60 } = options;
  const [status, setStatus] = useState<RecorderStatus>('idle');
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Blob | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const stop = useCallback(() => {
    recorderRef.current?.state === 'recording' && recorderRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setResult(null);
    setSeconds(0);

    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('error');
      setError('当前浏览器不支持录音，请改用 Chrome / Edge，或直接上传音频文件');
      return;
    }
    if (!window.isSecureContext) {
      setStatus('error');
      setError('录音功能需要在 HTTPS 或 localhost 环境下使用，当前页面非安全上下文');
      return;
    }

    setStatus('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
      streamRef.current = stream;
      chunksRef.current = [];

      const recorder = new MediaRecorder(stream);
      recorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        setStatus('processing');
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        try {
          const raw = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
          const wav = await convertToWav(raw);
          setResult(wav);
          setStatus('idle');
        } catch (conversionError) {
          setStatus('error');
          setError(conversionError instanceof Error ? conversionError.message : '音频转码失败，请重试');
        } finally {
          cleanup();
        }
      };

      recorder.start();
      setStatus('recording');

      timerRef.current = window.setInterval(() => {
        setSeconds((prev) => {
          const next = prev + 1;
          if (next >= maxSeconds) {
            recorderRef.current?.state === 'recording' && recorderRef.current.stop();
          }
          return next;
        });
      }, 1_000);
    } catch (mediaError) {
      cleanup();
      setStatus('error');
      const name = mediaError instanceof Error ? mediaError.name : '';
      setError(
        name === 'NotAllowedError'
          ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问，或改为上传音频文件'
          : name === 'NotFoundError'
            ? '未检测到可用的麦克风设备，请改为上传音频文件'
            : '无法启动录音，请检查麦克风设备或改为上传音频文件',
      );
    }
  }, [cleanup, maxSeconds]);

  const reset = useCallback(() => {
    setResult(null);
    setSeconds(0);
    setError(null);
    setStatus('idle');
  }, []);

  return { status, seconds, error, result, start, stop, reset, isRecording: status === 'recording' };
}
