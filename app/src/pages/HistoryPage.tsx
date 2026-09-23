import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, Clock, Download, FileAudio, Loader2, Play, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AudioPlayer } from '@/components/features/AudioPlayer';
import {
  buildAudioFilename,
  buildSegmentFilename,
  buildZipFilename,
  downloadBlob,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from '@/lib/audio';
import { blobToBytes, createZip } from '@/lib/zip';
import { MODE_META } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { AppSettings, HistoryRecord, TtsMode } from '@/types';

interface HistoryPageProps {
  records: HistoryRecord[];
  loading: boolean;
  settings: AppSettings;
  onRemove: (id: string) => Promise<void>;
  onClear: () => Promise<void>;
  onLoadAudio: (id: string) => Promise<{ blobs: Blob[]; urls: string[] }>;
}

const MODE_FILTERS: { value: TtsMode | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'preset', label: '通用合成' },
  { value: 'design', label: '音色设计' },
  { value: 'clone', label: '声音克隆' },
];

/** 历史记录：本地持久化，支持回听、逐段下载、打包导出与清理 */
export function HistoryPage({ records, loading, settings, onRemove, onClear, onLoadAudio }: HistoryPageProps) {
  const [filter, setFilter] = useState<TtsMode | 'all'>('all');
  const [keyword, setKeyword] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 每条记录加载后的分段音频与临时地址（一次读取同时缓存，避免重复读库与地址泄漏） */
  const [audioCache, setAudioCache] = useState<Record<string, { blobs: Blob[]; urls: string[] }>>({});
  const [zippingId, setZippingId] = useState<string | null>(null);

  // 卸载时释放全部临时地址
  useEffect(
    () => () => {
      Object.values(audioCache).forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return records.filter((record) => {
      if (filter !== 'all' && record.mode !== filter) return false;
      if (!query) return true;
      return (
        record.text.toLowerCase().includes(query) ||
        record.voiceLabel.toLowerCase().includes(query) ||
        (record.instruction ?? '').toLowerCase().includes(query)
      );
    });
  }, [filter, keyword, records]);

  /** 确保该记录的音频已加载，返回其 Blob 与临时地址 */
  const ensureAudio = useCallback(
    async (record: HistoryRecord): Promise<{ blobs: Blob[]; urls: string[] } | null> => {
      const cached = audioCache[record.id];
      if (cached) return cached;

      const result = await onLoadAudio(record.id);
      if (result.blobs.length === 0) return null;
      setAudioCache((prev) => ({ ...prev, [record.id]: result }));
      return result;
    },
    [audioCache, onLoadAudio],
  );

  const togglePlay = useCallback(
    async (record: HistoryRecord) => {
      if (expandedId === record.id) {
        setExpandedId(null);
        return;
      }
      const audio = await ensureAudio(record);
      if (!audio) {
        toast.error('音频数据已丢失', { description: '该记录可能已被清理，请重新合成' });
        return;
      }
      setExpandedId(record.id);
    },
    [ensureAudio, expandedId],
  );

  /** 下载单段 */
  const downloadSegment = useCallback(
    async (record: HistoryRecord, index: number) => {
      const audio = await ensureAudio(record);
      const blob = audio?.blobs[index];
      if (!blob) {
        toast.error('音频数据已丢失，无法下载');
        return;
      }
      const total = audio.blobs.length;
      downloadBlob(blob, total > 1 ? buildSegmentFilename(index, record.text, total) : buildAudioFilename(record.text, record.mode));
    },
    [ensureAudio],
  );

  /** 打包导出全部段落 */
  const downloadAll = useCallback(
    async (record: HistoryRecord) => {
      const audio = await ensureAudio(record);
      if (!audio) {
        toast.error('音频数据已丢失，无法导出');
        return;
      }
      setZippingId(record.id);
      try {
        const total = audio.blobs.length;
        const entries = await Promise.all(
          audio.blobs.map(async (blob, index) => ({
            name: buildSegmentFilename(index, record.text, total),
            data: await blobToBytes(blob),
          })),
        );
        const zip = createZip(entries);
        downloadBlob(zip, buildZipFilename(record.text, record.mode));
        toast.success('打包完成', { description: `已导出 ${total} 段音频（${formatBytes(zip.size)}）` });
      } catch {
        toast.error('打包失败', { description: '请重试，或改为逐段下载' });
      } finally {
        setZippingId(null);
      }
    },
    [ensureAudio],
  );

  const handleRemove = useCallback(
    async (record: HistoryRecord) => {
      if (expandedId === record.id) setExpandedId(null);
      const entry = audioCache[record.id];
      if (entry) {
        entry.urls.forEach((url) => URL.revokeObjectURL(url));
        setAudioCache((prev) => {
          const next = { ...prev };
          delete next[record.id];
          return next;
        });
      }
      await onRemove(record.id);
      toast.success('已删除该条记录');
    },
    [audioCache, expandedId, onRemove],
  );

  const handleClear = useCallback(async () => {
    if (!window.confirm(`确定要清空全部 ${records.length} 条历史记录吗？此操作不可恢复。`)) return;
    Object.values(audioCache).forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    setAudioCache({});
    setExpandedId(null);
    await onClear();
    toast.success('历史记录已清空');
  }, [audioCache, onClear, records.length]);

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Tabs value={filter} onValueChange={(value) => setFilter(value as TtsMode | 'all')}>
            <TabsList>
              {MODE_FILTERS.map((item) => (
                <TabsTrigger key={item.value} value={item.value} className="text-xs">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索文本或音色名称"
              className="h-9 pl-8"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {filtered.length} / {records.length} 条
            </span>
            <Button variant="outline" size="sm" onClick={() => void handleClear()} disabled={records.length === 0}>
              <Trash2 className="size-4" />
              清空
            </Button>
          </div>
        </CardContent>
      </Card>

      {loading ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">正在读取本地记录…</CardContent>
        </Card>
      ) : null}

      {!loading && filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-14 text-center">
            <FileAudio className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{records.length === 0 ? '还没有合成记录' : '没有匹配的记录'}</p>
            <p className="max-w-sm text-xs text-muted-foreground">
              {records.length === 0
                ? '在任意合成页面生成语音后，记录会自动保存在浏览器本地，最多保留 ' + settings.historyLimit + ' 条'
                : '试试更换筛选条件或清空搜索关键词'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {filtered.map((record) => {
          const expanded = expandedId === record.id;
          const meta = MODE_META[record.mode];
          const urls = audioCache[record.id]?.urls;
          const segmentCount = record.segmentCount || 1;
          return (
            <Card key={record.id} className={cn('overflow-hidden transition', expanded && 'ring-1 ring-violet-500/30')}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Button
                    size="icon"
                    variant={expanded ? 'default' : 'outline'}
                    className={cn(
                      'size-10 shrink-0 rounded-full',
                      expanded && 'bg-gradient-to-br from-violet-600 to-indigo-500',
                    )}
                    onClick={() => void togglePlay(record)}
                    aria-label={expanded ? '收起' : '展开并播放'}
                  >
                    <Play className="size-4 fill-current pl-0.5" />
                  </Button>

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="line-clamp-2 text-sm leading-relaxed">{record.text}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="h-5 font-normal">
                        {meta.label}
                      </Badge>
                      <Badge variant="outline" className="h-5 font-normal">
                        {record.voiceLabel}
                      </Badge>
                      {segmentCount > 1 ? (
                        <Badge variant="outline" className="h-5 gap-1 font-normal">
                          {segmentCount} 段
                        </Badge>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatRelativeTime(record.createdAt)}
                      </span>
                      <span>·</span>
                      <span>{formatDuration(record.durationSec)}</span>
                      <span>·</span>
                      <span>{formatBytes(record.bytes)}</span>
                    </div>
                    {record.instruction ? (
                      <p className="line-clamp-1 text-[11px] text-muted-foreground">指令：{record.instruction}</p>
                    ) : null}
                  </div>

                  <div className="flex shrink-0 gap-1">
                    {segmentCount > 1 ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void downloadAll(record)}
                        disabled={zippingId === record.id}
                        aria-label="打包导出全部段落"
                        title="打包导出全部段落（ZIP）"
                      >
                        {zippingId === record.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Archive className="size-4" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void downloadSegment(record, 0)}
                        aria-label="下载音频"
                      >
                        <Download className="size-4" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => void handleRemove(record)}
                      aria-label="删除记录"
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>

                {expanded && urls ? (
                  <>
                    <Separator className="my-3" />
                    <div className="space-y-3">
                      {urls.map((url, index) => (
                        <div key={`${record.id}-${index}`} className="space-y-1.5">
                          {urls.length > 1 ? (
                            <div className="flex items-center justify-between px-1">
                              <Badge variant="outline" className="h-5 text-[11px] font-normal">
                                第 {index + 1} 段
                              </Badge>
                            </div>
                          ) : null}
                          <AudioPlayer
                            src={url}
                            gain={settings.playbackGain}
                            autoPlay={index === 0}
                            compact={urls.length > 1}
                            onDownload={() => void downloadSegment(record, index)}
                          />
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
