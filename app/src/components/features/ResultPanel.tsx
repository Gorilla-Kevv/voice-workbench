import { useState } from 'react';
import { Archive, AudioLines, Clock, Download, Layers, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { AudioPlayer } from '@/components/features/AudioPlayer';
import { ErrorAlert } from '@/components/features/ErrorAlert';
import {
  buildAudioFilename,
  buildSegmentFilename,
  buildZipFilename,
  downloadBlob,
  formatBytes,
  formatDuration,
} from '@/lib/audio';
import { blobToBytes, createZip } from '@/lib/zip';
import type { RequestError } from '@/lib/api';
import type { AppSettings, RenderedSegment, SynthesisResult } from '@/types';

interface ResultPanelProps {
  result: SynthesisResult | null;
  loading: boolean;
  elapsed: number;
  error: RequestError | null;
  settings: AppSettings;
  onRetry?: () => void;
  onDismissError?: () => void;
  emptyHint: string;
}

/** 合成结果面板：加载态、错误态、空态与多段结果堆叠展示 */
export function ResultPanel({
  result,
  loading,
  elapsed,
  error,
  settings,
  onRetry,
  onDismissError,
  emptyHint,
}: ResultPanelProps) {
  const [zipping, setZipping] = useState(false);

  /** 下载单段音频 */
  const downloadSegment = (segment: RenderedSegment, total: number) => {
    if (!result) return;
    downloadBlob(segment.blob, buildSegmentFilename(segment.index, segment.text, total));
  };

  /** 打包全部段落为 ZIP 导出 */
  const downloadAll = async () => {
    if (!result) return;
    setZipping(true);
    try {
      const total = result.segments.length;
      const entries = await Promise.all(
        result.segments.map(async (segment) => ({
          name: buildSegmentFilename(segment.index, segment.text, total),
          data: await blobToBytes(segment.blob),
        })),
      );
      const zip = createZip(entries);
      downloadBlob(zip, buildZipFilename(result.text, result.mode));
      toast.success('打包完成', { description: `已导出 ${total} 段音频（${formatBytes(zip.size)}）` });
    } catch {
      toast.error('打包失败', { description: '请重试，或改为逐段下载' });
    } finally {
      setZipping(false);
    }
  };

  return (
    <Card className="sticky top-24">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          <span className="flex items-center gap-2">
            <AudioLines className="size-4 text-violet-600 dark:text-violet-400" />
            合成结果
          </span>
          {result && !loading ? (
            <Badge variant="secondary" className="text-[11px] font-normal">
              {result.segmentCount} 段
            </Badge>
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin text-violet-600" />
              <span>正在合成语音{elapsed > 0 ? `，已等待 ${elapsed} 秒` : '…'}</span>
            </div>
            <Skeleton className="h-24 w-full rounded-xl" />
            <p className="text-xs text-muted-foreground">
              音色设计与声音克隆模式需完整推理后才返回音频，通常需要 10～40 秒
            </p>
          </div>
        ) : null}

        {!loading && error ? <ErrorAlert error={error} onRetry={onRetry} onDismiss={onDismissError} /> : null}

        {!loading && !error && !result ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center">
            <Sparkles className="size-6 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{emptyHint}</p>
          </div>
        ) : null}

        {!loading && result ? (
          <div className="space-y-3">
            {/* 概要信息 */}
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-2">
                <Clock className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">总时长</span>
                <span className="ml-auto font-medium tabular-nums">{formatDuration(result.durationSec)}</span>
              </div>
              <div className="flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-2">
                <AudioLines className="size-3.5 text-muted-foreground" />
                <span className="text-muted-foreground">总体积</span>
                <span className="ml-auto font-medium tabular-nums">{formatBytes(result.bytes)}</span>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="font-mono text-[11px] font-normal">
                {result.model}
              </Badge>
              <Badge variant="secondary" className="text-[11px] font-normal">
                音色：{result.voiceLabel}
              </Badge>
              {result.segmented ? (
                <Badge variant="secondary" className="gap-1 text-[11px] font-normal">
                  <Layers className="size-3" />
                  长文本分 {result.segmentCount} 段
                </Badge>
              ) : null}
            </div>

            {/* 多段时提供整包导出 */}
            {result.segmented ? (
              <Button variant="outline" size="sm" className="w-full" onClick={() => void downloadAll()} disabled={zipping}>
                {zipping ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
                {zipping ? '正在打包…' : `打包下载全部 ${result.segmentCount} 段（ZIP）`}
              </Button>
            ) : null}

            {/* 分段堆叠展示：每段独立播放、独立下载 */}
            <ScrollArea className={result.segmentCount > 1 ? 'max-h-[26rem] pr-1' : undefined}>
              <div className="space-y-3">
                {result.segments.map((segment) => (
                  <div key={segment.index} className="space-y-1.5">
                    {result.segmented ? (
                      <div className="flex items-center justify-between px-1">
                        <Badge variant="outline" className="h-5 text-[11px] font-normal">
                          第 {segment.index + 1} 段
                        </Badge>
                        <span className="text-[11px] tabular-nums text-muted-foreground">
                          {formatDuration(segment.durationSec)} · {formatBytes(segment.bytes)}
                        </span>
                      </div>
                    ) : null}

                    <AudioPlayer
                      src={segment.url}
                      gain={settings.playbackGain}
                      autoPlay={settings.autoPlay && segment.index === 0}
                      compact={result.segmented}
                      onDownload={() => downloadSegment(segment, result.segmentCount)}
                    />

                    {result.segmented ? (
                      <p className="px-1 text-[11px] leading-relaxed text-muted-foreground line-clamp-2">
                        {segment.text}
                      </p>
                    ) : null}
                  </div>
                ))}
              </div>
            </ScrollArea>

            {!result.segmented ? (
              <>
                <p className="rounded-lg bg-muted/50 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground line-clamp-3">
                  {result.text}
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => downloadBlob(result.segments[0].blob, buildAudioFilename(result.text, result.mode))}
                >
                  <Download className="size-4" />
                  下载 WAV
                </Button>
              </>
            ) : null}

            <p className="text-[11px] text-muted-foreground">已自动保存到「历史记录」，可在其中回听与再次下载</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
