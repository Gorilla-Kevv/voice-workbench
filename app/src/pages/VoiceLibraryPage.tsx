import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  FileAudio,
  FolderOpen,
  LibraryBig,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Progress } from '@/components/ui/progress';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TermTip } from '@/components/features/TermTip';
import { ResourceHubList } from '@/components/features/ResourceHub';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { asrApi } from '@/lib/asr';
import { formatBytes, formatDuration, formatRelativeTime } from '@/lib/audio';
import { RequestError } from '@/lib/errors';
import { sovitsApi } from '@/lib/sovits';
import { voiceApi } from '@/lib/voices';
import { dropHighlight, useFileDrop } from '@/hooks/useFileDrop';
import { cn } from '@/lib/utils';
import type { SovitsCatalog, SovitsVoice } from '@/types';

/** 与网关 voiceLibrary 的 ALLOWED_SUFFIXES 同表：客户端先拦一道，报错更友好 */
const ALLOWED_SUFFIXES = ['.wav', '.mp3', '.flac', '.ogg', '.m4a', '.webm', '.aac', '.wma'];
const ACCEPT_ATTR = ALLOWED_SUFFIXES.join(',');

type StatusFilter = 'all' | 'ok' | 'warn' | 'missing';
type SortKey = 'updated' | 'created' | 'name' | 'duration' | 'size';

/** 行内状态：文件丢失 > 有警告 > 正常（与网关 warnings 口径一致） */
function statusOf(voice: SovitsVoice): Exclude<StatusFilter, 'all'> {
  if (!voice.exists) return 'missing';
  return voice.warnings.length > 0 ? 'warn' : 'ok';
}

const STATUS_META: Record<Exclude<StatusFilter, 'all'>, { label: string; className: string }> = {
  ok: { label: '正常', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  warn: { label: '有警告', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-400' },
  missing: { label: '文件丢失', className: 'bg-destructive/15 text-destructive' },
};

/** 下载文件名去掉 Windows 非法字符 */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'voice';
}

/**
 * 音色库管理页。
 *
 * 这个页面的存在本身就是 GPT-SoVITS 与「预置音色型」TTS 的分界线：
 * 它**没有任何内置音色**，一次零样本克隆需要「3~10 秒参考音频 + 这段音频的逐字转写」。
 * 把这两样东西绑定成一个可命名的实体、并常驻在本地，是把模型变成工具的关键一步 ——
 * 否则用户每次合成都得重新上传一遍。
 *
 * 存储与接口：数据在仓库根 `voicelib/`，由**网关**直接供（`/api/voicelib`）——
 * 音色库跨模型通用，本页不要求 GPT-SoVITS 服务在线。
 *
 * 管理面（阶段 26补8）：搜索 / 类型·语种·状态筛选 / 排序 / 分页 /
 * 多选批量删除与批量导出 / 单条精导（带参考文本）与批量快导（多文件按文件名登记）。
 * 批量快导登记出来的音色**没有参考文本**（会标警告），补文本用编辑弹窗或一键智能转写。
 */
export function VoiceLibraryPage() {
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  /** 「一键智能转写」的独立忙碌态：它与「保存音色」互不阻塞 */
  const [transcribing, setTranscribing] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SovitsVoice | null>(null);

  // 管理面状态
  const [query, setQuery] = useState('');
  const [originFilter, setOriginFilter] = useState<'all' | 'managed' | 'external'>('all');
  const [langFilter, setLangFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [sortBy, setSortBy] = useState<SortKey>('updated');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // 批量导入进度（null = 不在导入中）
  const [batchImport, setBatchImport] = useState<{
    total: number;
    done: number;
    current: string;
    failed: { name: string; reason: string }[];
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  const batchInputRef = useRef<HTMLInputElement>(null);

  // 新建表单
  const [name, setName] = useState('');
  const [promptText, setPromptText] = useState('');
  const [promptLang, setPromptLang] = useState('zh');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [externalPath, setExternalPath] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [voiceResult, catalogResult] = await Promise.all([
        voiceApi.listVoices(),
        sovitsApi.catalog().catch(() => null),
      ]);
      setVoices(voiceResult.voices);
      if (catalogResult) setCatalog(catalogResult.catalog);
      setError(null);
    } catch (err) {
      setError((err as RequestError).fullMessage);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 一键智能转写：把已选中的参考音频交给 ASR，结果直接填进「参考文本」。
   *
   * 为什么值得做成一个按钮：参考文本必须逐字正确 —— 错字会被**直接学进模型**，
   * 表现为某些字读音怪异，事后极难定位；而边听边打字既慢又必然出错。
   */
  const handleTranscribe = useCallback(async () => {
    if (!file && !externalPath.trim()) {
      toast.warning('请先选择参考音频，或填写一个本机路径');
      return;
    }
    setTranscribing(true);
    try {
      const result = await asrApi.transcribe({
        file: file ?? undefined,
        source: file ? undefined : externalPath.trim(),
        language: promptLang || 'zh',
      });
      if (!result.text) {
        toast.warning('未识别到文本', {
          description: result.warning ?? '试着手动填写，或换一段更干净、更清晰的人声。',
        });
        return;
      }
      setPromptText(result.text);
      toast.success('已转写并填入参考文本', {
        description: `${result.channel === 'resident' ? '常驻模型' : '官方脚本'} · ${result.backend} · ${result.elapsed_s} 秒${
          result.cached ? ' · 命中缓存' : ''
        }`,
      });
    } catch (err) {
      toast.error('智能转写失败', { description: (err as RequestError).fullMessage });
    } finally {
      setTranscribing(false);
    }
  }, [file, externalPath, promptLang]);

  const resetForm = useCallback(() => {
    setName('');
    setPromptText('');
    setPromptLang('zh');
    setNote('');
    setTags('');
    setFile(null);
    setExternalPath('');
  }, []);

  const handleCreate = useCallback(async () => {
    if (!name.trim()) {
      toast.warning('请填写音色名称');
      return;
    }
    const draft = {
      name: name.trim(),
      prompt_text: promptText.trim(),
      // 必须兜底：undefined 会被转成字符串 "undefined" 存进库（坑 8 的老教训）
      prompt_lang: promptLang || 'zh',
      note: note.trim(),
      tags: tags.split(/[,，\s]+/).filter(Boolean),
    };

    if (!file && !externalPath.trim()) {
      toast.warning('请选择音频文件，或填写一个本地路径');
      return;
    }

    setSubmitting(true);
    try {
      const result = file
        ? await voiceApi.createVoice(draft, file)
        : await voiceApi.createVoiceFromPath({ ...draft, audio_path: externalPath.trim() });
      toast.success('音色已保存', {
        description: result.voice.warnings.length
          ? result.voice.warnings[0]
          : `${result.voice.name} · ${result.voice.duration_s?.toFixed(1) ?? '?'} 秒`,
      });
      setCreateOpen(false);
      resetForm();
      await load();
    } catch (err) {
      toast.error('保存失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, [name, promptText, promptLang, note, tags, file, externalPath, resetForm, load]);

  /**
   * 批量快导：一次选多段音频，按文件名登记。
   * 与单条精导（导入音色弹窗）互补——素材已在手、先入库后补文本的工作流。
   */
  const handleBatchImport = useCallback(
    async (files: File[]) => {
      const accepted: File[] = [];
      const rejected: { name: string; reason: string }[] = [];
      for (const item of files) {
        const suffix = item.name.slice(item.name.lastIndexOf('.')).toLowerCase();
        if (!ALLOWED_SUFFIXES.includes(suffix)) {
          rejected.push({ name: item.name, reason: `不支持的格式 ${suffix || '(无扩展名)'}` });
        } else if (item.size > 64 * 1024 * 1024) {
          rejected.push({ name: item.name, reason: '超过 64 MB 上限' });
        } else {
          accepted.push(item);
        }
      }
      if (rejected.length > 0) {
        toast.error(`${rejected.length} 个文件被拒绝`, {
          description: rejected
            .slice(0, 5)
            .map((item) => `${item.name}：${item.reason}`)
            .join('\n'),
        });
      }
      if (accepted.length === 0) return;

      setBatchImport({ total: accepted.length, done: 0, current: accepted[0].name, failed: [] });
      let okCount = 0;
      const failed: { name: string; reason: string }[] = [];
      for (let index = 0; index < accepted.length; index += 1) {
        const item = accepted[index];
        setBatchImport((prev) => (prev ? { ...prev, current: item.name } : prev));
        try {
          await voiceApi.createVoice(
            {
              name: safeFileName(item.name.replace(/\.[^.]+$/, '')),
              prompt_text: '',
              prompt_lang: promptLang || 'zh',
            },
            item,
          );
          okCount += 1;
        } catch (err) {
          failed.push({ name: item.name, reason: (err as RequestError).message ?? '导入失败' });
        }
        setBatchImport((prev) => (prev ? { ...prev, done: index + 1, failed: [...failed] } : prev));
      }
      setBatchImport(null);
      if (failed.length === 0) {
        toast.success(`已导入 ${okCount} 条音色`, {
          description: okCount > 0 ? '批量登记的音色缺参考文本，编辑或用「一键智能转写」补齐' : undefined,
        });
      } else {
        toast.error(`导入完成：成功 ${okCount} 条，失败 ${failed.length} 条`, {
          description: failed.slice(0, 5).map((item) => `${item.name}：${item.reason}`).join('\n'),
        });
      }
      await load();
    },
    [load, promptLang],
  );

  const handleUpdate = useCallback(async () => {
    if (!editing) return;
    setSubmitting(true);
    try {
      const result = await voiceApi.updateVoice(editing.id, {
        name: editing.name,
        prompt_text: editing.prompt_text,
        prompt_lang: editing.prompt_lang || 'zh',
        note: editing.note,
      });
      toast.success('已更新', { description: result.voice.warnings[0] ?? '音色信息已保存' });
      setEditing(null);
      await load();
    } catch (err) {
      toast.error('更新失败', { description: (err as RequestError).fullMessage });
    } finally {
      setSubmitting(false);
    }
  }, [editing, load]);

  const handleReplaceAudio = useCallback(
    async (voice: SovitsVoice, next: File) => {
      setSubmitting(true);
      try {
        await voiceApi.replaceVoiceAudio(voice.id, next);
        toast.success('已替换音频');
        setEditing(null);
        await load();
      } catch (err) {
        toast.error('替换失败', { description: (err as RequestError).fullMessage });
      } finally {
        setSubmitting(false);
      }
    },
    [load],
  );

  // 两处「参考音频」都收拖拽：新建时填表用一条，编辑时替换用另一条
  const { dragging: newAudioDragging, rootProps: newAudioDropProps } = useFileDrop({
    onFiles: (files) => {
      const next = files[0] ?? null;
      setFile(next);
      if (next) setExternalPath('');
    },
    accept: ACCEPT_ATTR,
    disabled: submitting,
    inputRef: fileRef,
  });

  const replaceAudioRef = useRef<HTMLInputElement>(null);
  const { dragging: replaceAudioDragging, rootProps: replaceAudioDropProps } = useFileDrop({
    onFiles: (files) => {
      const next = files[0];
      if (next && editing) void handleReplaceAudio(editing, next);
    },
    accept: ACCEPT_ATTR,
    disabled: submitting || !editing,
    inputRef: replaceAudioRef,
  });

  const handleDelete = useCallback(
    async (voice: SovitsVoice) => {
      if (!window.confirm(`确定删除音色「${voice.name}」吗？托管音频文件会一并移除，此操作不可撤销。`)) return;
      try {
        await voiceApi.deleteVoice(voice.id);
        setSelected((prev) => {
          const next = new Set(prev);
          next.delete(voice.id);
          return next;
        });
        toast.success('已删除');
        await load();
      } catch (err) {
        toast.error('删除失败', { description: (err as RequestError).fullMessage });
      }
    },
    [load],
  );

  const handleBatchDelete = useCallback(async () => {
    const targets = voices.filter((voice) => selected.has(voice.id));
    if (targets.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${targets.length} 条音色吗？托管音频文件会一并移除，此操作不可撤销。`)) return;
    let okCount = 0;
    const failed: string[] = [];
    for (const voice of targets) {
      try {
        await voiceApi.deleteVoice(voice.id);
        okCount += 1;
      } catch {
        failed.push(voice.name);
      }
    }
    setSelected(new Set());
    if (failed.length === 0) toast.success(`已删除 ${okCount} 条音色`);
    else toast.error(`删除完成：成功 ${okCount} 条，失败 ${failed.length} 条`, { description: failed.join('、') });
    await load();
  }, [voices, selected, load]);

  /** 批量导出：逐条从网关取回音频并触发浏览器下载（文件名 = 音色名.原扩展名） */
  const handleBatchExport = useCallback(async () => {
    const targets = voices.filter((voice) => selected.has(voice.id) && voice.exists);
    if (targets.length === 0) {
      toast.warning('选中的音色里没有可导出的音频（文件丢失的不计入）');
      return;
    }
    setExporting(true);
    let okCount = 0;
    const failed: string[] = [];
    for (const voice of targets) {
      try {
        const response = await fetch(voiceApi.voiceAudioUrl(voice.id));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        const suffix = voice.audio_path.slice(voice.audio_path.lastIndexOf('.')).toLowerCase() || '.wav';
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${safeFileName(voice.name)}-${voice.id}${suffix}`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        okCount += 1;
      } catch {
        failed.push(voice.name);
      }
      // 连续触发下载会被浏览器拦成「允许此网站下载多个文件」询问，留一点间隔
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
    setExporting(false);
    if (failed.length === 0) toast.success(`已导出 ${okCount} 条参考音频`, { description: '浏览器若询问「允许下载多个文件」，请选允许' });
    else toast.error(`导出完成：成功 ${okCount} 条，失败 ${failed.length} 条`, { description: failed.join('、') });
  }, [voices, selected]);

  const languages = catalog?.languages ?? [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
    { id: 'yue', label: '粤语' },
  ];
  const langLabel = (id: string) => languages.find((item) => item.id === id)?.label ?? id;

  // ------------------------------------------------------------------
  // 搜索 / 筛选 / 排序 / 分页（全部客户端：本地库量级小，切一次筛不重新请求）
  // ------------------------------------------------------------------

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const list = voices.filter((voice) => {
      if (originFilter !== 'all' && (voice.origin === 'external' ? 'external' : 'managed') !== originFilter) return false;
      if (langFilter !== 'all' && voice.prompt_lang !== langFilter) return false;
      if (statusFilter !== 'all' && statusOf(voice) !== statusFilter) return false;
      if (!keyword) return true;
      const haystack = [voice.name, voice.note, voice.prompt_text, ...voice.tags].join(' ').toLowerCase();
      return haystack.includes(keyword);
    });
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sortBy) {
        case 'name':
          return a.name.localeCompare(b.name, 'zh');
        case 'duration':
          return (b.duration_s ?? -1) - (a.duration_s ?? -1);
        case 'size':
          return b.size_bytes - a.size_bytes;
        case 'created':
          return b.created_at - a.created_at;
        default:
          return (b.updated_at || b.created_at) - (a.updated_at || a.created_at);
      }
    });
    return sorted;
  }, [voices, query, originFilter, langFilter, statusFilter, sortBy]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount);
  const rows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);
  const problemCount = useMemo(() => voices.filter((voice) => voice.warnings.length > 0).length, [voices]);
  const filtersActive = query.trim() !== '' || originFilter !== 'all' || langFilter !== 'all' || statusFilter !== 'all';

  // 筛选条件变了回到第一页，避免停在空白页
  useEffect(() => {
    setPage(1);
  }, [query, originFilter, langFilter, statusFilter, pageSize]);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const pageAllSelected = rows.length > 0 && rows.every((voice) => selected.has(voice.id));
  const toggleSelectPage = useCallback(() => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (rows.every((voice) => next.has(voice.id))) rows.forEach((voice) => next.delete(voice.id));
      else rows.forEach((voice) => next.add(voice.id));
      return next;
    });
  }, [rows]);

  if (error) {
    return (
      <Alert variant="destructive">
        <Server className="size-4" />
        <AlertTitle>音色库读取失败</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{error}</p>
          <p className="text-xs">音色库由本机网关直接提供，不需要 GPT-SoVITS / 任何模型服务在线。</p>
          <Button size="sm" variant="outline" onClick={() => void load()}>
            <RefreshCw className="mr-1.5 size-3.5" />
            重新检测
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      <Alert>
        <Mic className="size-4" />
        <AlertTitle>GPT-SoVITS 没有内置音色</AlertTitle>
        <AlertDescription>
          一次零样本克隆需要「3~10 秒的参考音频」+「这段音频的逐字转写文本」。
          音频要求单人、无背景音乐、无混响；转写文本要准确，错字会被直接学进模型。
          想获得更高相似度，可以到「音色微调训练」用 1 分钟以上的语料微调出专属权重。
        </AlertDescription>
      </Alert>

      <div className="grid items-start gap-5 lg:grid-cols-3">
        <div className="min-w-0 space-y-5 lg:col-span-2">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">音色库（{voices.length}）</CardTitle>
            <CardDescription>
              {problemCount > 0
                ? `${problemCount} 个音色存在会影响合成的问题，已标黄`
                : '全部音色状态正常，可直接用于合成与批量合成'}
              {filtersActive ? ` · 当前筛选出 ${filtered.length} 条` : ''}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
            <input
              ref={batchInputRef}
              type="file"
              accept={ACCEPT_ATTR}
              multiple
              className="hidden"
              onChange={(event) => {
                const picked = Array.from(event.target.files ?? []);
                event.target.value = '';
                if (picked.length > 0) void handleBatchImport(picked);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => batchInputRef.current?.click()}
              disabled={Boolean(batchImport)}
              title="一次选择多段音频，按文件名快速登记（参考文本之后补）"
            >
              <Upload className="mr-1.5 size-3.5" />
              批量导入
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              导入音色
            </Button>
          </div>
        </CardHeader>

        {/* 导入进度：批量快导跑动时占一条，跑完自动消失 */}
        {batchImport ? (
          <div className="mx-6 mb-3 rounded-lg border bg-muted/30 p-3">
            <div className="flex items-center justify-between gap-3 text-xs">
              <p className="flex min-w-0 items-center gap-2">
                <Loader2 className="size-3.5 shrink-0 animate-spin text-violet-600 dark:text-violet-400" />
                <span className="truncate">
                  正在导入（{batchImport.done + 1}/{batchImport.total}）：{batchImport.current}
                </span>
              </p>
              <span className="shrink-0 text-muted-foreground">
                {batchImport.failed.length > 0 ? `已失败 ${batchImport.failed.length} 条` : '暂无失败'}
              </span>
            </div>
            <Progress value={(batchImport.done / batchImport.total) * 100} className="mt-2 h-1.5" />
          </div>
        ) : null}

        {/* 工具条：搜索 + 三个筛选 + 排序 */}
        <div className="flex flex-wrap items-center gap-2 px-6 pb-3">
          <div className="relative min-w-[180px] flex-1 basis-52">
            <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索名称 / 标签 / 备注 / 参考文本"
              className="h-8 pl-8 text-xs"
            />
            {query ? (
              <button
                type="button"
                onClick={() => setQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
                title="清空搜索"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
          <Select value={originFilter} onValueChange={(value) => setOriginFilter(value as typeof originFilter)}>
            <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="按类型筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">类型：全部</SelectItem>
              <SelectItem value="managed">本地托管</SelectItem>
              <SelectItem value="external">引用磁盘</SelectItem>
            </SelectContent>
          </Select>
          <Select value={langFilter} onValueChange={setLangFilter}>
            <SelectTrigger className="h-8 w-[110px] text-xs" aria-label="按语种筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">语种：全部</SelectItem>
              {languages.map((item) => (
                <SelectItem key={item.id} value={item.id}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
            <SelectTrigger className="h-8 w-[118px] text-xs" aria-label="按状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">状态：全部</SelectItem>
              <SelectItem value="ok">正常</SelectItem>
              <SelectItem value="warn">有警告</SelectItem>
              <SelectItem value="missing">文件丢失</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sortBy} onValueChange={(value) => setSortBy(value as SortKey)}>
            <SelectTrigger className="h-8 w-[122px] text-xs" aria-label="排序方式">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="updated">最近更新</SelectItem>
              <SelectItem value="created">最新导入</SelectItem>
              <SelectItem value="name">名称</SelectItem>
              <SelectItem value="duration">时长</SelectItem>
              <SelectItem value="size">大小</SelectItem>
            </SelectContent>
          </Select>
          {filtersActive ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 px-2 text-xs"
              onClick={() => {
                setQuery('');
                setOriginFilter('all');
                setLangFilter('all');
                setStatusFilter('all');
              }}
            >
              <X className="mr-1 size-3" />
              清除筛选
            </Button>
          ) : null}
        </div>

        {/* 批量操作条：有选中才出现 */}
        {selected.size > 0 ? (
          <div className="mx-6 mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-violet-300/60 bg-violet-500/5 px-3 py-2 text-xs dark:border-violet-500/30">
            <span className="font-medium text-violet-700 dark:text-violet-300">已选 {selected.size} 条</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => void handleBatchExport()} disabled={exporting}>
              {exporting ? <Loader2 className="mr-1.5 size-3 animate-spin" /> : <Upload className="mr-1.5 size-3 rotate-180" />}
              批量导出音频
            </Button>
            <Button size="sm" variant="outline" className="h-7 text-xs text-destructive hover:text-destructive" onClick={() => void handleBatchDelete()}>
              <Trash2 className="mr-1.5 size-3" />
              批量删除
            </Button>
            <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
              取消选择
            </Button>
          </div>
        ) : null}

        <CardContent>
          {loading && voices.length === 0 ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              正在读取音色库…
            </div>
          ) : voices.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center">
              <FileAudio className="mx-auto size-8 text-muted-foreground" />
              <p className="mt-3 text-sm font-medium">音色库还是空的</p>
              <p className="mt-1 text-xs text-muted-foreground">
                导入一段 3~10 秒的干净人声即可开始零样本克隆；素材多就用「批量导入」
              </p>
              <div className="mt-4 flex justify-center gap-2">
                <Button size="sm" variant="outline" onClick={() => batchInputRef.current?.click()}>
                  <Upload className="mr-1.5 size-3.5" />
                  批量导入
                </Button>
                <Button size="sm" onClick={() => setCreateOpen(true)}>
                  <Plus className="mr-1.5 size-3.5" />
                  导入第一个音色
                </Button>
              </div>
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              没有符合筛选条件的音色
              <Button size="sm" variant="link" onClick={() => { setQuery(''); setOriginFilter('all'); setLangFilter('all'); setStatusFilter('all'); }}>
                清除筛选
              </Button>
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border">
              {/* 表头 */}
              <div className="flex items-center gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground">
                <Checkbox
                  checked={pageAllSelected}
                  onCheckedChange={() => toggleSelectPage()}
                  aria-label="全选本页"
                  className="size-3.5 shrink-0"
                />
                <span className="min-w-0 flex-1">名称 / 标签</span>
                <span className="hidden w-16 shrink-0 md:block">类型</span>
                <span className="hidden w-14 shrink-0 md:block">语种</span>
                <span className="hidden w-16 shrink-0 lg:block">时长</span>
                <span className="hidden w-16 shrink-0 lg:block">大小</span>
                <span className="hidden w-24 shrink-0 xl:block">导入时间</span>
                <span className="w-16 shrink-0">状态</span>
                <span className="w-[72px] shrink-0 text-right">操作</span>
              </div>
              {rows.map((voice) => {
                const status = statusOf(voice);
                const expanded = expandedId === voice.id;
                return (
                  <div key={voice.id} className={cn('border-b last:border-b-0', selected.has(voice.id) && 'bg-violet-500/5')}>
                    <div className="flex items-center gap-2 px-3 py-2">
                      <Checkbox
                        checked={selected.has(voice.id)}
                        onCheckedChange={() => toggleSelect(voice.id)}
                        aria-label={`选择 ${voice.name}`}
                        className="size-3.5 shrink-0"
                      />
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : voice.id)}
                        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                        title={expanded ? '收起详情' : '展开试听与详情'}
                      >
                        {expanded ? <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />}
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">{voice.name}</span>
                          {voice.tags.length > 0 ? (
                            <span className="block truncate text-[10px] text-muted-foreground">{voice.tags.join(' · ')}</span>
                          ) : null}
                        </span>
                      </button>
                      <span className="hidden w-16 shrink-0 md:block">
                        <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">
                          {voice.origin === 'external' ? '引用磁盘' : '本地托管'}
                        </Badge>
                      </span>
                      <span className="hidden w-14 shrink-0 text-xs text-muted-foreground md:block">{langLabel(voice.prompt_lang)}</span>
                      <span className="hidden w-16 shrink-0 text-xs tabular-nums text-muted-foreground lg:block">
                        {voice.duration_s ? `${voice.duration_s.toFixed(1)} 秒` : '未知'}
                      </span>
                      <span className="hidden w-16 shrink-0 text-xs tabular-nums text-muted-foreground lg:block">{formatBytes(voice.size_bytes)}</span>
                      <span className="hidden w-24 shrink-0 text-[11px] text-muted-foreground xl:block">
                        {formatRelativeTime(voice.created_at * 1000)}
                      </span>
                      <span className="w-16 shrink-0">
                        <span className={cn('inline-block rounded-full px-1.5 py-0.5 text-[10px] font-medium', STATUS_META[status].className)}>
                          {STATUS_META[status].label}
                        </span>
                      </span>
                      <span className="flex w-[72px] shrink-0 justify-end gap-1">
                        <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(voice)} title="编辑 / 替换音频 / 一键转写">
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="size-7 text-destructive hover:text-destructive"
                          onClick={() => void handleDelete(voice)}
                          title="删除"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </span>
                    </div>
                    {expanded ? (
                      <div className="space-y-2 px-3 pb-3 pl-10">
                        {voice.exists ? (
                          <audio controls preload="none" className="h-8 w-full" src={voiceApi.voiceAudioUrl(voice.id)} />
                        ) : (
                          <p className="text-xs text-destructive">音频文件已丢失，请重新上传（编辑弹窗里可直接拖入替换）</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {voice.prompt_text ? `参考文本：${voice.prompt_text}` : '⚠️ 未填写参考文本 —— GPT-SoVITS v3/v4 会直接报错，点「编辑」补上或用「一键智能转写」'}
                        </p>
                        {voice.note ? <p className="text-xs text-muted-foreground">备注：{voice.note}</p> : null}
                        <p className="font-mono text-[10px] text-muted-foreground">
                          id: {voice.id} · {voice.sample_rate ? `${voice.sample_rate} Hz · ` : ''}更新于 {formatRelativeTime(voice.updated_at * 1000)}
                        </p>
                        <p className="break-all font-mono text-[10px] text-muted-foreground">{voice.audio_path}</p>
                        {voice.warnings.length > 0 ? (
                          <div className="rounded-md bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-400">
                            {voice.warnings.map((warning) => (
                              <p key={warning} className="flex items-start gap-1.5">
                                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                                {warning}
                              </p>
                            ))}
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}

          {/* 分页 */}
          {filtered.length > 0 ? (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <p>
                共 {filtered.length} 条 · 第 {safePage}/{pageCount} 页
              </p>
              <div className="flex items-center gap-2">
                <Select value={String(pageSize)} onValueChange={(value) => setPageSize(Number(value))}>
                  <SelectTrigger className="h-7 w-[92px] text-xs" aria-label="每页条数">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[10, 20, 50].map((size) => (
                      <SelectItem key={size} value={String(size)}>
                        {size} 条/页
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>
                  上一页
                </Button>
                <Button size="sm" variant="outline" className="h-7 px-2" disabled={safePage >= pageCount} onClick={() => setPage(safePage + 1)}>
                  下一页
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

        </div>

        {/* 右侧三分之一：资源库面板（与顶栏下拉同一份数据，可滚动浏览） */}
        <Card className="lg:col-span-1 lg:sticky lg:top-20">
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <LibraryBig className="size-4 text-violet-600 dark:text-violet-400" />
              资源库
            </CardTitle>
            <CardDescription>
              缺素材、缺模型、缺教程：音色模型 / 训练语料 / B站配布分类清单，滚动浏览（外部链接新窗口打开）
            </CardDescription>
          </CardHeader>
          <CardContent className="scrollbar-thin max-h-[68vh] overflow-y-auto">
            <ResourceHubList />
          </CardContent>
        </Card>
      </div>

      {/* ---------------- 新建（单条精导：带参考文本） ---------------- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入音色</DialogTitle>
            <DialogDescription>
              上传一段 3~10 秒的干净人声，并填写它的逐字转写文本。两者共同决定克隆效果。
              素材多是本地文件？用工具条上的「批量导入」更快。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="voice-name">
                  <TermTip term="音色">音色名称</TermTip>
                </Label>
              <Input
                id="voice-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：播报男声-低沉"
              />
            </div>

            <div className="space-y-2" {...newAudioDropProps}>
              <Label htmlFor="voice-file">
                  <TermTip term="参考音频" />（可拖文件进来）
                </Label>
              <input
                ref={fileRef}
                id="voice-file"
                type="file"
                accept={ACCEPT_ATTR}
                className="hidden"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next) setExternalPath('');
                  event.target.value = '';
                }}
              />
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-lg border border-transparent px-1 py-1 transition',
                  dropHighlight(newAudioDragging),
                )}
              >
                <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
                  <Upload className="mr-1.5 size-3.5" />
                  选择音频文件
                </Button>
                {file ? (
                  <span className="text-xs text-muted-foreground">
                    {file.name} · {formatBytes(file.size)}
                  </span>
                ) : null}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="voice-path" className="flex items-center gap-1.5">
                <FolderOpen className="size-3.5" />
                或引用磁盘上已有的文件
              </Label>
              <Input
                id="voice-path"
                value={externalPath}
                onChange={(event) => {
                  setExternalPath(event.target.value);
                  if (event.target.value) setFile(null);
                }}
                placeholder="例如 D:\\素材\\播报男声.wav（不会被复制）"
                disabled={Boolean(file)}
              />
              <p className="text-[11px] text-muted-foreground">
                参考音频需为 3~10 秒；请填写本机绝对路径
              </p>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <div className="space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                  <Label htmlFor="voice-prompt">
                    <TermTip term="提示文本">参考文本（逐字转写）</TermTip>
                  </Label>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    title="用本地 ASR 模型识别参考音频，自动填入逐字转写文本。识别结果需要人工核对。"
                    disabled={transcribing || submitting || (!file && !externalPath.trim())}
                    onClick={() => void handleTranscribe()}
                  >
                    {transcribing ? (
                      <Loader2 className="mr-1 size-3 animate-spin" />
                    ) : (
                      <Sparkles className="mr-1 size-3" />
                    )}
                    一键智能转写（标注 ASR 模型）
                  </Button>
                </div>
                <Textarea
                  id="voice-prompt"
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                  placeholder="这段音频里实际说了什么，就写什么"
                  className="min-h-[72px]"
                />
                <p className="text-[11px] text-muted-foreground">
                  缺少参考文本会导致相似度明显下降，v3/v4 模型还会直接报错；自动转写的结果请对照音频核对一遍
                </p>
              </div>
              <div className="space-y-2">
                <Label>
                            <TermTip term="参考音频语种" />
                          </Label>
                <Select value={promptLang} onValueChange={setPromptLang}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {languages.map((item) => (
                      <SelectItem key={item.id} value={item.id}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="voice-note">备注（可选）</Label>
              <Input
                id="voice-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="例如：适合纪录片旁白"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="voice-tags">标签（逗号分隔，可选）</Label>
              <Input
                id="voice-tags"
                value={tags}
                onChange={(event) => setTags(event.target.value)}
                placeholder="男声, 低沉, 播报"
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreateOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void handleCreate()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              保存音色
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------- 编辑 ---------------- */}
      <Dialog open={Boolean(editing)} onOpenChange={(open) => (open ? undefined : setEditing(null))}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>编辑音色</DialogTitle>
            <DialogDescription>修正参考文本往往能直接提升相似度，值得反复试。</DialogDescription>
          </DialogHeader>

          {editing ? (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>名称</Label>
                <Input
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
                    <Label>
                      <TermTip term="提示文本">参考文本</TermTip>
                    </Label>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      title="用本地 ASR 识别这条音色的参考音频，自动填入。识别结果需要人工核对。"
                      disabled={transcribing || submitting || !editing.exists}
                      onClick={async () => {
                        setTranscribing(true);
                        try {
                          const response = await fetch(voiceApi.voiceAudioUrl(editing.id));
                          if (!response.ok) throw new Error(`音频取回失败（HTTP ${response.status}）`);
                          const blob = await response.blob();
                          const audioFile = new File([blob], `${editing.name}.wav`, { type: blob.type || 'audio/wav' });
                          const result = await asrApi.transcribe({ file: audioFile, language: editing.prompt_lang || 'zh' });
                          if (!result.text) {
                            toast.warning('未识别到文本', { description: result.warning ?? '换一段更干净的人声再试，或手动填写。' });
                          } else {
                            setEditing((prev) => (prev ? { ...prev, prompt_text: result.text } : prev));
                            toast.success('已转写，请核对后保存');
                          }
                        } catch (err) {
                          toast.error('智能转写失败', { description: (err as RequestError).fullMessage ?? String(err) });
                        } finally {
                          setTranscribing(false);
                        }
                      }}
                    >
                      {transcribing ? <Loader2 className="mr-1 size-3 animate-spin" /> : <Sparkles className="mr-1 size-3" />}
                      一键智能转写
                    </Button>
                  </div>
                  <Textarea
                    value={editing.prompt_text}
                    onChange={(event) => setEditing({ ...editing, prompt_text: event.target.value })}
                    className="min-h-[72px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                            <TermTip term="参考音频语种">语种</TermTip>
                          </Label>
                  <Select
                    value={editing.prompt_lang}
                    onValueChange={(value) => setEditing({ ...editing, prompt_lang: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {languages.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>备注</Label>
                <Input
                  value={editing.note}
                  onChange={(event) => setEditing({ ...editing, note: event.target.value })}
                />
              </div>

              <Separator />

              <div className="space-y-2" {...replaceAudioDropProps}>
                <Label>
                  <TermTip term="参考音频">替换参考音频</TermTip>（可拖文件进来）
                </Label>
                <input
                  ref={replaceAudioRef}
                  type="file"
                  accept={ACCEPT_ATTR}
                  onChange={(event) => {
                    const next = event.target.files?.[0];
                    if (next) void handleReplaceAudio(editing, next);
                    event.target.value = '';
                  }}
                  className={cn(
                    'block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs',
                    dropHighlight(replaceAudioDragging),
                  )}
                />
                <p className="text-[11px] text-muted-foreground">
                  当前时长 {editing.duration_s ? `${editing.duration_s.toFixed(1)} 秒` : '未知'}，
                  官方要求 3~10 秒
                </p>
              </div>
            </div>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void handleUpdate()} disabled={submitting}>
              {submitting ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
              保存修改
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-center text-xs text-muted-foreground">
        参考音频与转写文本全部保存在本机（仓库根 <code className="rounded bg-muted px-1 py-0.5">voicelib/</code>，网关与 GPT-SoVITS 共用），不会被上传到任何服务器。
        {voices.length > 0
          ? ` 当前音色总时长 ${formatDuration(
              voices.reduce((sum, voice) => sum + (voice.duration_s ?? 0), 0),
            )}。`
          : ''}
      </p>
    </div>
  );
}
