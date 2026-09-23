import { useCallback, useEffect, useRef, useState } from 'react';
import { FileAudio, Mic, Square, Trash2, UploadCloud } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { ACCEPTED_SAMPLE_TYPES, MAX_SAMPLE_BYTES } from '@/lib/constants';
import { blobToDataUri, formatBytes, formatDuration } from '@/lib/audio';
import { useRecorder } from '@/hooks/useRecorder';
import { cn } from '@/lib/utils';
import type { VoiceSample } from '@/types';

interface SamplePickerProps {
  value: VoiceSample | null;
  onChange: (sample: VoiceSample | null) => void;
  onError?: (message: string) => void;
}

/**
 * 音频样本采集：支持文件上传与麦克风录制。
 * 录制结果自动转码为 24kHz 单声道 WAV，满足克隆接口的格式要求。
 */
export function SamplePicker({ value, onChange, onError }: SamplePickerProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const recorder = useRecorder({ maxSeconds: 60 });

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewDuration, setPreviewDuration] = useState(0);

  // 由样本 data URI 生成播放地址
  useEffect(() => {
    if (!value) {
      setPreviewUrl(null);
      setPreviewDuration(0);
      return;
    }
    let revoked = false;
    if (value.url) {
      setPreviewUrl(value.url);
    } else {
      try {
        const [meta, base64] = value.dataUri.split(',');
        const mime = meta.match(/data:([^;]+)/)?.[1] ?? 'audio/wav';
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        const blobUrl = URL.createObjectURL(new Blob([bytes], { type: mime }));
        setPreviewUrl(blobUrl);
        return () => {
          revoked = true;
          if (revoked) URL.revokeObjectURL(blobUrl);
        };
      } catch {
        setPreviewUrl(null);
      }
    }
    return () => {
      revoked = true;
    };
  }, [value]);

  const acceptFile = useCallback(
    async (file: File) => {
      const extension = file.name.split('.').pop()?.toLowerCase() ?? '';
      const typeOk = ACCEPTED_SAMPLE_TYPES.includes(file.type) || ['mp3', 'wav'].includes(extension);

      if (!typeOk) {
        onError?.('音频样本仅支持 mp3 与 wav 格式');
        return;
      }
      if (file.size > MAX_SAMPLE_BYTES) {
        onError?.(`文件 ${formatBytes(file.size)} 超出 10MB 限制，请压缩或裁剪后重试`);
        return;
      }

      setBusy(true);
      try {
        const dataUri = await blobToDataUri(file);
        onChange({
          dataUri,
          mimeType: file.type || (extension === 'wav' ? 'audio/wav' : 'audio/mpeg'),
          bytes: file.size,
          source: 'upload',
          name: file.name,
          url: URL.createObjectURL(file),
        });
      } catch (error) {
        onError?.(error instanceof Error ? error.message : '读取音频文件失败');
      } finally {
        setBusy(false);
      }
    },
    [onChange, onError],
  );

  // 录制完成后写入样本
  useEffect(() => {
    if (!recorder.result) return;
    let cancelled = false;
    void (async () => {
      try {
        const dataUri = await blobToDataUri(recorder.result as Blob);
        if (cancelled) return;
        onChange({
          dataUri,
          mimeType: 'audio/wav',
          bytes: recorder.result!.size,
          source: 'record',
          name: `录音-${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.wav`,
          url: URL.createObjectURL(recorder.result as Blob),
        });
      } catch {
        onError?.('录音转码失败，请重试');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recorder.result, onChange, onError]);

  const handleFiles = useCallback(
    (files: FileList | null) => {
      const file = files?.[0];
      if (file) void acceptFile(file);
    },
    [acceptFile],
  );

  const clear = () => {
    if (value?.url) URL.revokeObjectURL(value.url);
    onChange(null);
    recorder.reset();
    if (inputRef.current) inputRef.current.value = '';
  };

  if (value) {
    return (
      <div className="space-y-3 rounded-xl border bg-muted/30 p-4">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-violet-500/10 text-violet-600">
            <FileAudio className="size-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{value.name}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {value.mimeType.replace('audio/', '').toUpperCase()} · {formatBytes(value.bytes)} ·{' '}
              {value.source === 'record' ? '麦克风录制' : '文件上传'}
              {previewDuration > 0 ? ` · ${formatDuration(previewDuration)}` : ''}
            </p>
          </div>
          <Button variant="ghost" size="icon" onClick={clear} aria-label="移除样本">
            <Trash2 className="size-4" />
          </Button>
        </div>

        {previewUrl ? (
          <audio
            src={previewUrl}
            controls
            className="h-9 w-full"
            onLoadedMetadata={(event) => setPreviewDuration(event.currentTarget.duration || 0)}
          />
        ) : null}

        <p className="text-xs text-muted-foreground">
          建议使用 5～30 秒清晰、无背景音乐的人声片段，克隆相似度更高
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          handleFiles(event.dataTransfer.files);
        }}
        className={cn(
          'flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition',
          dragging ? 'border-violet-500 bg-violet-500/5' : 'border-border hover:border-violet-300 hover:bg-muted/50',
          busy && 'pointer-events-none opacity-60',
        )}
      >
        <UploadCloud className="size-7 text-muted-foreground" />
        <p className="text-sm font-medium">{busy ? '正在读取文件…' : '点击选择或拖拽音频文件到此处'}</p>
        <p className="text-xs text-muted-foreground">支持 mp3 / wav，单个文件不超过 10MB</p>
        <input
          ref={inputRef}
          type="file"
          accept="audio/mpeg,audio/mp3,audio/wav,audio/x-wav,.mp3,.wav"
          className="hidden"
          onChange={(event) => handleFiles(event.target.files)}
        />
      </div>

      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground">或直接录制</span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col items-center gap-2 rounded-xl border bg-muted/20 p-4">
        {recorder.isRecording ? (
          <>
            <Button
              variant="destructive"
              size="icon"
              onClick={recorder.stop}
              className="recording-pulse size-12 rounded-full"
              aria-label="停止录音"
            >
              <Square className="size-5 fill-current" />
            </Button>
            <p className="text-sm font-medium tabular-nums">
              录制中 {formatDuration(recorder.seconds)} / 1:00
            </p>
            <Progress value={(recorder.seconds / 60) * 100} className="h-1.5 w-full max-w-xs" />
            <p className="text-xs text-muted-foreground">请朗读一段完整句子，保持环境安静</p>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              size="icon"
              onClick={() => void recorder.start()}
              disabled={recorder.status === 'processing' || recorder.status === 'requesting'}
              className="size-12 rounded-full"
              aria-label="开始录音"
            >
              <Mic className="size-5" />
            </Button>
            <p className="text-sm font-medium">
              {recorder.status === 'processing'
                ? '正在转码为 WAV…'
                : recorder.status === 'requesting'
                  ? '等待麦克风授权…'
                  : '点击开始录音'}
            </p>
            <p className="text-xs text-muted-foreground">最长录制 60 秒，需要 HTTPS 或 localhost 环境</p>
          </>
        )}
        {recorder.error ? <p className="text-xs text-destructive">{recorder.error}</p> : null}
      </div>
    </div>
  );
}
