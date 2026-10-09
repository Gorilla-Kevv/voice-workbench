import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Archive, Check, Clock, Copy, Download, FileAudio, Loader2, Play, RefreshCw, Search, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AudioPlayer } from '@/components/features/AudioPlayer';
import { SovitsServiceNotice } from '@/components/features/SovitsServiceNotice';
import {
  buildAudioFilename,
  buildSegmentFilename,
  buildZipFilename,
  downloadBlob,
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from '@/lib/audio';
import { ENGINE_LABELS, GROUP_LABELS, jobStateLabel } from '@/lib/jobArtifacts';
import { useOutputRecords } from '@/hooks/useOutputRecords';
import { cn } from '@/lib/utils';
import { blobToBytes, createZip } from '@/lib/zip';
import type { AppSettings, HistoryRecord, OutputGroup } from '@/types';

/**
 * 产出记录页 —— 替换原来的「历史记录」。
 *
 * 改前这个页面只显示 MiMo：数据在浏览器 IndexedDB 里，
 * 而本地引擎的产物**一直都在服务端**（`trainer/.data/jobs/*.json`）——
 * 不是没记录，只是没有页面去读它。
 *
 * 现在三源合并：
 *   1. 服务端任务（`GET /v1/jobs`，不带 kind）—— 推理与训练，全引擎；
 *   2. 本地模型文件（`GET /api/models/*`）—— 训练产物与导入的权重；
 *   3. 云端合成（IndexedDB）—— MiMo，唯一的云端产物来源，**并入**而非删掉。
 *
 * 每条记录都尽量同时给「能听」与「能找到」：
 * 音频用内联播放器，文件路径可点击复制（用户明确要求过「也给出本地路径」）。
 */

interface OutputsPageProps {
  /** 云端合成记录（IndexedDB），由 App 持有状态，合成成功后会自动写入 */
  cloudRecords: HistoryRecord[];
  cloudLoading: boolean;
  settings: AppSettings;
  onRemove: (id: string) => Promise<void>;
  onClear: () => Promise<void>;
  onLoadAudio: (id: string) => Promise<{ blobs: Blob[]; urls: string[] }>;
  /** 跳到设置页（服务停用提示里用） */
  onGoSettings?: () => void;
}

const GROUP_FILTERS: { value: OutputGroup | 'all'; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'infer', label: GROUP_LABELS.infer },
  { value: 'train', label: GROUP_LABELS.train },
  { value: 'model', label: GROUP_LABELS.model },
  { value: 'cloud', label: GROUP_LABELS.cloud },
];

/** 状态 → 配色（成功绿、失败红、进行中蓝，其余中性） */
function statusClass(label: string): string {
  if (label === '成功') return 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400';
  if (label === '失败' || label === '缺配套文件') return 'border-destructive/40 text-destructive';
  if (label === '进行中') return 'border-sky-500/40 text-sky-600 dark:text-sky-400';
  return '';
}

/** 本机路径：点击复制（拿去资源管理器里定位） */
function CopyPathButton({
  path,
  copied,
  onCopy,
}: {
  path: string;
  copied: string | null;
  onCopy: (path: string) => void;
}) {
  return (
    <button
      type="button"
      className="mt-1 block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
      title="点击复制完整路径"
      onClick={() => onCopy(path)}
    >
      {copied === path ? (
        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
          <Check className="size-3" /> 已复制
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <Copy className="size-3 shrink-0" /> {path}
        </span>
      )}
    </button>
  );
}

export function OutputsPage({
  cloudRecords,
  cloudLoading,
  settings,
  onRemove,
  onClear,
  onLoadAudio,
  onGoSettings,
}: OutputsPageProps) {
  const { records, loading, jobError, modelError, jobTruncated, refresh } = useOutputRecords(cloudRecords);
  const [group, setGroup] = useState<OutputGroup | 'all'>('all');
  const [engine, setEngine] = useState<string>('all');
  const [keyword, setKeyword] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  /** 云端记录展开后读出的音频（一次读取同时缓存，避免重复读库与地址泄漏） */
  const [audioCache, setAudioCache] = useState<Record<string, { blobs: Blob[]; urls: string[] }>>({});
  const [zippingId, setZippingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  // 卸载时释放全部临时地址
  useEffect(
    () => () => {
      Object.values(audioCache).forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const engines = useMemo(() => {
    const seen = new Set(records.map((record) => record.engine));
    return Array.from(seen).sort((a, b) => (ENGINE_LABELS[a] ?? a).localeCompare(ENGINE_LABELS[b] ?? b));
  }, [records]);

  const filtered = useMemo(() => {
    const query = keyword.trim().toLowerCase();
    return records.filter((record) => {
      if (group !== 'all' && record.group !== group) return false;
      if (engine !== 'all' && record.engine !== engine) return false;
      if (!query) return true;
      return record.title.toLowerCase().includes(query) || (record.note ?? '').toLowerCase().includes(query);
    });
  }, [records, group, engine, keyword]);

  const copyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      setCopied(path);
      window.setTimeout(() => setCopied((prev) => (prev === path ? null : prev)), 1500);
    } catch {
      toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中路径复制。' });
    }
  }, []);

  /** 确保该云端记录的音频已读出，返回 Blob 与临时地址 */
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

  const toggleCloud = useCallback(
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

  const handleRemoveCloud = useCallback(
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
      toast.success('已删除该条云端记录');
    },
    [audioCache, expandedId, onRemove],
  );

  const handleClearCloud = useCallback(async () => {
    if (!window.confirm(`确定要清空全部 ${cloudRecords.length} 条云端合成记录吗？此操作不可恢复。`)) return;
    Object.values(audioCache).forEach((entry) => entry.urls.forEach((url) => URL.revokeObjectURL(url)));
    setAudioCache({});
    setExpandedId(null);
    await onClear();
    toast.success('云端合成记录已清空');
  }, [audioCache, cloudRecords.length, onClear]);

  const busy = loading || cloudLoading;
  const hasAny = records.length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-3 p-4">
          <Tabs value={group} onValueChange={(value) => setGroup(value as OutputGroup | 'all')}>
            <TabsList>
              {GROUP_FILTERS.map((item) => (
                <TabsTrigger key={item.value} value={item.value} className="text-xs">
                  {item.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Select value={engine} onValueChange={setEngine}>
            <SelectTrigger className="h-9 w-[150px] text-xs">
              <SelectValue placeholder="引擎" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">
                全部引擎
              </SelectItem>
              {engines.map((key) => (
                <SelectItem key={key} value={key} className="text-xs">
                  {ENGINE_LABELS[key] ?? key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              placeholder="搜索标题、音色或失败原因"
              className="h-9 pl-8"
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {filtered.length} / {records.length} 条
            </span>
            <Button variant="ghost" size="icon" onClick={refresh} aria-label="刷新" title="重新读取三源数据">
              <RefreshCw className="size-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleClearCloud()}
              disabled={cloudRecords.length === 0}
            >
              <Trash2 className="size-4" />
              清空云端记录
            </Button>
          </div>
        </CardContent>
      </Card>

      {jobError ? (
        <div className="space-y-2">
          <SovitsServiceNotice onGoSettings={onGoSettings} />
          <p className="flex items-center gap-1.5 px-1 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="size-3.5" />
            服务端任务暂时读不到（{jobError}）。本地模型与云端记录不受影响，照常显示。
          </p>
        </div>
      ) : null}

      {modelError ? (
        <p className="flex items-center gap-1.5 px-1 text-xs text-destructive">
          <AlertTriangle className="size-3.5" />
          模型清单读取失败：{modelError}
        </p>
      ) : null}

      {jobTruncated ? (
        <p className="px-1 text-xs text-muted-foreground">
          服务端任务最多返回 {records.filter((record) => record.source === 'job').length} 条（接口上限 200），更早的请用各引擎页面内的结果面板查看。
        </p>
      ) : null}

      {busy && !hasAny ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">正在读取产出记录…</CardContent>
        </Card>
      ) : null}

      {!busy && filtered.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-14 text-center">
            <FileAudio className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{hasAny ? '没有匹配的记录' : '还没有任何产出'}</p>
            <p className="max-w-md text-xs text-muted-foreground">
              {hasAny
                ? '试试更换分组 / 引擎，或清空搜索关键词。'
                : '本地引擎跑一次推理或训练、往 models/ 里放一个模型、或用云端合成一段语音，记录都会自动出现在这里。'}
            </p>
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-3">
        {filtered.map((record) => {
          const cloud = record.cloud;
          const expanded = expandedId === record.id;
          const urls = cloud ? audioCache[cloud.id]?.urls : undefined;
          const statusText = record.status
            ? record.source === 'job'
              ? jobStateLabel(record.status)
              : record.status
            : null;
          const segmentCount = cloud?.segmentCount || 1;
          return (
            <Card key={record.id} className={cn('overflow-hidden transition', expanded && 'ring-1 ring-violet-500/30')}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  {cloud ? (
                    <Button
                      size="icon"
                      variant={expanded ? 'default' : 'outline'}
                      className={cn(
                        'size-10 shrink-0 rounded-full',
                        expanded && 'bg-gradient-to-br from-violet-600 to-indigo-500',
                      )}
                      onClick={() => void toggleCloud(cloud)}
                      aria-label={expanded ? '收起' : '展开并播放'}
                    >
                      <Play className="size-4 fill-current pl-0.5" />
                    </Button>
                  ) : null}

                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="line-clamp-2 text-sm leading-relaxed">{record.title}</p>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <Badge variant="secondary" className="h-5 font-normal">
                        {GROUP_LABELS[record.group]}
                      </Badge>
                      <Badge variant="outline" className="h-5 font-normal">
                        {ENGINE_LABELS[record.engine] ?? record.engine}
                      </Badge>
                      {statusText ? (
                        <Badge variant="outline" className={cn('h-5 font-normal', statusClass(statusText))}>
                          {statusText}
                        </Badge>
                      ) : null}
                      {cloud && segmentCount > 1 ? (
                        <Badge variant="outline" className="h-5 gap-1 font-normal">
                          {segmentCount} 段
                        </Badge>
                      ) : null}
                      <span className="inline-flex items-center gap-1">
                        <Clock className="size-3" />
                        {formatRelativeTime(record.createdAt)}
                      </span>
                      {cloud ? (
                        <>
                          <span>·</span>
                          <span>{formatDuration(cloud.durationSec)}</span>
                          <span>·</span>
                          <span>{formatBytes(cloud.bytes)}</span>
                        </>
                      ) : null}
                    </div>
                    {record.note ? <p className="line-clamp-1 text-[11px] text-muted-foreground">{record.note}</p> : null}
                  </div>

                  {cloud ? (
                    <div className="flex shrink-0 gap-1">
                      {segmentCount > 1 ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void downloadAll(cloud)}
                          disabled={zippingId === cloud.id}
                          aria-label="打包导出全部段落"
                          title="打包导出全部段落（ZIP）"
                        >
                          {zippingId === cloud.id ? <Loader2 className="size-4 animate-spin" /> : <Archive className="size-4" />}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => void downloadSegment(cloud, 0)}
                          aria-label="下载音频"
                        >
                          <Download className="size-4" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => void handleRemoveCloud(cloud)}
                        aria-label="删除记录"
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  ) : null}
                </div>

                {record.artifacts.length > 0 ? (
                  <div className="mt-3 space-y-2">
                    {record.artifacts.map((artifact) => (
                      <div key={artifact.key} className="rounded-md bg-muted/40 p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[11px] font-medium text-muted-foreground">{artifact.label}</span>
                          {artifact.bytes ? (
                            <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(artifact.bytes)}</span>
                          ) : null}
                        </div>
                        {artifact.url ? (
                          <audio className="h-8 w-full" controls preload="none" src={artifact.url} />
                        ) : null}
                        {artifact.path ? (
                          <CopyPathButton path={artifact.path} copied={copied} onCopy={(path) => void copyPath(path)} />
                        ) : null}
                        {!artifact.url && !artifact.path ? (
                          <p className="text-[11px] text-muted-foreground">该产物既没有可播放地址，也没有本机路径。</p>
                        ) : null}
                      </div>
                    ))}
                  </div>
                ) : null}

                {!cloud && record.artifacts.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {record.source === 'model' ? '这个模型条目没有扫描到文件。' : '这条任务没有产出文件。'}
                  </p>
                ) : null}

                {cloud && expanded && urls ? (
                  <>
                    <Separator className="my-3" />
                    <div className="space-y-3">
                      {urls.map((url, index) => (
                        <div key={`${cloud.id}-${index}`} className="space-y-1.5">
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
                            onDownload={() => void downloadSegment(cloud, index)}
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
