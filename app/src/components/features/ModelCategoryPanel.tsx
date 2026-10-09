import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  FileWarning,
  FolderOpen,
  FolderUp,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ModelEditDialog } from '@/components/features/ModelEditDialog';
import { useFileDrop } from '@/hooks/useFileDrop';
import { RequestError } from '@/lib/errors';
import {
  conflictOf,
  formatBytes,
  modelsApi,
  type ModelCategoryKey,
  type ModelCategoryView,
  type ModelEntry,
  type ModelStrayFile,
  type MigrationPlan,
} from '@/lib/models';
import { cn } from '@/lib/utils';

/**
 * 模型类别的统一面板（RVC / DDSP-SVC / GPT-SoVITS / 网易 共用）。
 *
 * 两条导入路径**并列、互不冲突**（都落在同一个类别目录里）：
 *   * 方式 A：用资源管理器把文件拖进 `models/<category>/`，然后点「重新扫描」；
 *   * 方式 B：本面板的「导入文件 / 导入文件夹」，上传后立即出现在列表里。
 * 两者靠**同一个注册表**统一（扫描无状态、每次现扫），所以不存在「网页导入的模型在别处」。
 *
 * 文件夹导入**保留相对结构**（不拍平）—— 拍平正是改前混乱的来源之一。
 * 拖拽导入会拍平（`useFileDrop` 的目录遍历不保留路径），需要保留结构请用「导入文件夹」。
 */
interface ModelCategoryPanelProps {
  category: ModelCategoryKey;
  /** 类别元信息由父级统一取（避免每个 Tab 各请求一次 catalog） */
  info: ModelCategoryView | null;
  /** 某个模型被增删改后通知父级刷新计数 */
  onChanged?: () => void;
}

interface ImportProgress {
  total: number;
  done: number;
  current: string;
  failed: { name: string; reason: string }[];
}

export function ModelCategoryPanel({ category, info, onChanged }: ModelCategoryPanelProps) {
  const [models, setModels] = useState<ModelEntry[]>([]);
  /** 目录里「不构成模型」的散文件 —— 不能静默丢弃，否则用户以为没放进去 */
  const [strays, setStrays] = useState<ModelStrayFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<ModelEntry | null>(null);
  const [importProgress, setImportProgress] = useState<ImportProgress | null>(null);
  const [renameOpen, setRenameOpen] = useState(false);
  const [migratePlan, setMigratePlan] = useState<MigrationPlan | null>(null);
  const [migrating, setMigrating] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  /** 刚复制成功的路径（本机路径给用户拿去资源管理器定位用） */
  const [copied, setCopied] = useState<string | null>(null);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(text);
      window.setTimeout(() => setCopied((prev) => (prev === text ? null : prev)), 1500);
    } catch {
      toast.error('复制失败', { description: '浏览器拒绝了剪贴板访问，请手动选中路径复制。' });
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await modelsApi.list(category);
      setModels(payload.models);
      setStrays(payload.strays ?? []);
      setSelected((prev) => new Set([...prev].filter((id) => payload.models.some((m) => m.id === id))));
    } catch (err) {
      setError((err as RequestError).fullMessage ?? (err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---------------------------------------------------------------- 导入

  /**
   * 上传一批文件。
   *
   * 冲突处理做成**一次询问、批量套用**：拖一个几十文件的文件夹进来时，
   * 逐个弹窗会把人逼疯；这里第一次遇到冲突就停下来问，用户的选择应用到本批剩余文件。
   */
  const uploadBatch = useCallback(
    async (files: File[], subdirOf: (file: File) => string) => {
      if (files.length === 0) return;
      let policy: 'reject' | 'overwrite' | 'keep_both' = 'reject';
      let askedPolicy = false;
      const failed: { name: string; reason: string }[] = [];

      setImportProgress({ total: files.length, done: 0, current: files[0].name, failed: [] });

      for (let index = 0; index < files.length; index += 1) {
        const file = files[index];
        setImportProgress({ total: files.length, done: index, current: file.name, failed: [...failed] });
        try {
          await modelsApi.importFile(category, file, { subdir: subdirOf(file), onConflict: policy });
        } catch (err) {
          const conflict = conflictOf(err);
          if (conflict && !askedPolicy) {
            // 第一次撞冲突：让用户决定，并应用到本批剩余文件
            const choice = window.confirm(
              `「${conflict.existing.rel}」已存在且大小相同。\n\n` +
                `确定 = 保留两份（自动加 -1 后缀）\n取消 = 跳过这一个`,
            );
            policy = choice ? 'keep_both' : 'reject';
            askedPolicy = true;
            try {
              await modelsApi.importFile(category, file, { subdir: subdirOf(file), onConflict: policy });
            } catch (retryErr) {
              failed.push({ name: file.name, reason: (retryErr as RequestError).message });
            }
          } else if (conflict) {
            // 本批已定策略，仍走 reject 说明用户选了跳过
            failed.push({ name: file.name, reason: '已存在同名同大小文件，已跳过' });
          } else {
            failed.push({ name: file.name, reason: (err as RequestError).message });
          }
        }
      }

      setImportProgress({ total: files.length, done: files.length, current: '', failed });
      await refresh();
      onChanged?.();

      const okCount = files.length - failed.length;
      if (failed.length === 0) {
        toast.success(`已导入 ${okCount} 个文件`);
      } else {
        toast.warning(`导入完成：成功 ${okCount} 个，跳过/失败 ${failed.length} 个`, {
          description: failed
            .slice(0, 3)
            .map((item) => `${item.name}：${item.reason}`)
            .join('\n'),
        });
      }
      // 进度条留 1.5s 让用户看到结果再收
      window.setTimeout(() => setImportProgress(null), 1500);
    },
    [category, onChanged, refresh],
  );

  const handlePickFiles = useCallback(
    (fileList: FileList | null) => {
      void uploadBatch(Array.from(fileList ?? []), () => '');
    },
    [uploadBatch],
  );

  /** 文件夹导入：`webkitRelativePath` 形如 `MYGO全员/乐奈/lenai.pth`，取目录部分当 subdir */
  const handlePickFolder = useCallback(
    (fileList: FileList | null) => {
      void uploadBatch(Array.from(fileList ?? []), (file) => {
        const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? '';
        const parts = rel.split('/');
        return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
      });
    },
    [uploadBatch],
  );

  const { dragging, rootProps } = useFileDrop({
    onFiles: (files) => void uploadBatch(files, () => ''),
    multiple: true,
    disabled: importProgress !== null,
  });

  // ---------------------------------------------------------------- 其他操作

  const handleReveal = useCallback(async () => {
    setRevealing(true);
    try {
      const result = await modelsApi.reveal(category);
      toast.success('已在文件管理器打开', { description: result.dir });
    } catch (err) {
      toast.error('打开目录失败', { description: (err as RequestError).fullMessage });
    } finally {
      setRevealing(false);
    }
  }, [category]);

  const handleDelete = useCallback(
    async (model: ModelEntry) => {
      if (confirmId !== model.id) {
        setConfirmId(model.id);
        return;
      }
      setBusyId(model.id);
      try {
        const result = await modelsApi.remove(model.id);
        toast.success(`已删除「${model.name}」`, {
          description: `共移除 ${result.removed.length} 个文件（含配套索引 / 配置）`,
        });
        setConfirmId(null);
        await refresh();
        onChanged?.();
      } catch (err) {
        toast.error('删除失败', { description: (err as RequestError).fullMessage });
      } finally {
        setBusyId(null);
      }
    },
    [confirmId, onChanged, refresh],
  );

  const openMigratePlan = useCallback(async () => {
    try {
      setMigratePlan(await modelsApi.migratePlan(category));
    } catch (err) {
      toast.error('无法生成迁移计划', { description: (err as RequestError).fullMessage });
    }
  }, [category]);

  const runMigrate = useCallback(async () => {
    setMigrating(true);
    try {
      const result = await modelsApi.migrateRun(category);
      toast.success(`已迁移 ${result.moved.length} 个模型`, {
        description:
          result.skipped.length + result.failed.length > 0
            ? `跳过 ${result.skipped.length}、失败 ${result.failed.length}（未覆盖任何文件）`
            : '目录结构已保留',
      });
      setMigratePlan(null);
      await refresh();
      onChanged?.();
    } catch (err) {
      toast.error('迁移失败', { description: (err as RequestError).fullMessage });
    } finally {
      setMigrating(false);
    }
  }, [category, onChanged, refresh]);

  // ---------------------------------------------------------------- 统计

  const duplicates = useMemo(() => models.filter((item) => item.duplicate_of).length, [models]);
  const legacyCount = useMemo(() => models.filter((item) => item.legacy).length, [models]);
  const incompleteCount = useMemo(() => models.filter((item) => item.incomplete).length, [models]);
  const selectedModels = useMemo(() => models.filter((item) => selected.has(item.id)), [models, selected]);

  if (info?.reserved) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{info.label}</CardTitle>
          <CardDescription>{info.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <p>{info.reserved}</p>
          </div>
          <Button size="sm" variant="outline" onClick={() => void handleReveal()} disabled={revealing}>
            {revealing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <FolderOpen className="mr-1.5 size-3.5" />}
            打开预留目录
          </Button>
          <p className="text-[11px] text-muted-foreground">
            <code className="rounded bg-muted px-1">{info.dir}</code>
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className={cn('space-y-4 rounded-lg transition', dragging && 'ring-2 ring-violet-500/60')} {...rootProps}>
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div className="min-w-0">
            <CardTitle className="text-base">
              {info?.label ?? category}（{models.length}）
            </CardTitle>
            <CardDescription>{info?.hint}</CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button size="sm" onClick={() => fileInputRef.current?.click()} disabled={importProgress !== null}>
              <Upload className="mr-1.5 size-3.5" />
              导入文件
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => folderInputRef.current?.click()}
              disabled={importProgress !== null}
            >
              <FolderUp className="mr-1.5 size-3.5" />
              导入文件夹
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handleReveal()} disabled={revealing}>
              {revealing ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <FolderOpen className="mr-1.5 size-3.5" />}
              打开目录
            </Button>
            <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={loading}>
              {loading ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 size-3.5" />}
              重新扫描
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-2 pt-0">
          {/* 两个隐藏 input：文件夹那个靠 webkitdirectory 保留相对路径 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              handlePickFiles(event.target.files);
              event.target.value = '';
            }}
          />
          <input
            ref={folderInputRef}
            type="file"
            multiple
            // @ts-expect-error webkitdirectory 是 Chromium 专有属性，React 类型里没有
            webkitdirectory=""
            className="hidden"
            onChange={(event) => {
              handlePickFolder(event.target.files);
              event.target.value = '';
            }}
          />

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              <HardDrive className="size-3" />
              放这里：
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded bg-muted px-1 font-mono hover:bg-muted/70"
                onClick={() => {
                  void navigator.clipboard?.writeText(info?.dir ?? '');
                  toast.success('已复制目录路径');
                }}
                title="点击复制"
              >
                {info?.dir ?? '—'}
                <Copy className="size-2.5" />
              </button>
            </span>
            <span className="opacity-80">
              也可以把文件拖到本页（拖拽会拍平；要保留目录结构请用「导入文件夹」）
            </span>
          </div>

          {importProgress ? (
            <div className="space-y-1.5 rounded-md border px-2.5 py-2">
              <div className="flex items-center justify-between text-[11px]">
                <span className="truncate">
                  正在导入 {importProgress.done}/{importProgress.total}
                  {importProgress.current ? `：${importProgress.current}` : ''}
                </span>
                <span className="shrink-0 tabular-nums">
                  {Math.round((importProgress.done / Math.max(importProgress.total, 1)) * 100)}%
                </span>
              </div>
              <Progress value={(importProgress.done / Math.max(importProgress.total, 1)) * 100} className="h-1.5" />
            </div>
          ) : null}

          {legacyCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <div className="min-w-0 flex-1 space-y-1">
                <p>有 {legacyCount} 个模型在兼容读取的旧位置（仍可正常使用）。建议迁移到规范目录。</p>
                <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => void openMigratePlan()}>
                  查看迁移计划
                </Button>
              </div>
            </div>
          ) : null}

          {duplicates > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-2.5 py-1.5 text-[11px] text-destructive">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <p>
                发现 {duplicates} 个疑似重复（与另一个模型主权重同名同大小）。它们会同时出现在下拉框里，建议删掉多余的一份。
              </p>
            </div>
          ) : null}

          {incompleteCount > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3 shrink-0" />
              <p>
                有 {incompleteCount} 个模型缺必需配套文件（如 DDSP-SVC 的 <code>config.yaml</code>），加载会失败。
              </p>
            </div>
          ) : null}

          {strays.length > 0 ? (
            <div className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-400">
              <FileWarning className="mt-0.5 size-3 shrink-0" />
              <p>目录里还有 {strays.length} 个文件不构成模型（已单列在下方，附修复提示）。</p>
            </div>
          ) : null}

          {selected.size > 0 ? (
            <div className="flex items-center gap-2 rounded-md bg-muted/60 px-2.5 py-1.5 text-[11px]">
              <span>已选 {selected.size} 个</span>
              <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => setRenameOpen(true)}>
                批量重命名
              </Button>
              <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setSelected(new Set())}>
                取消选择
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {loading && models.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">正在扫描目录…</CardContent>
        </Card>
      ) : null}

      {error ? (
        <Card>
          <CardContent className="p-6 text-sm text-destructive">{error}</CardContent>
        </Card>
      ) : null}

      {!loading && !error && models.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 p-12 text-center">
            <HardDrive className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">这个类别还没有模型</p>
            <p className="max-w-md text-xs text-muted-foreground">
              点「导入文件 / 导入文件夹」，或把文件放进{' '}
              <code className="rounded bg-muted px-1">{info?.dir ?? 'models/'}</code> 后点「重新扫描」。
            </p>
          </CardContent>
        </Card>
      ) : null}

      {strays.length > 0 ? (
        <Card className="border-amber-500/30">
          <CardHeader className="p-3.5 pb-2">
            <CardTitle className="flex items-center gap-1.5 text-xs">
              <FileWarning className="size-3.5" /> 未识别文件（{strays.length}）
            </CardTitle>
            <CardDescription className="text-[11px]">
              这些文件确实在类别目录里，但不构成模型 —— 列出来是为了不让你以为「放进去了却没生效」。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-1.5 p-3.5 pt-0">
            {strays.map((stray) => (
              <div key={stray.abs} className="rounded-md bg-muted/40 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate font-mono text-[11px]">{stray.rel}</span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">{formatBytes(stray.bytes)}</span>
                </div>
                <p className="mt-0.5 text-[11px] text-amber-700 dark:text-amber-400">{stray.hint}</p>
                <button
                  type="button"
                  className="mt-0.5 block w-full truncate text-left font-mono text-[11px] text-muted-foreground transition hover:text-foreground"
                  title="点击复制完整路径"
                  onClick={() => void copyText(stray.abs)}
                >
                  {copied === stray.abs ? (
                    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                      <Check className="size-3" /> 已复制
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1">
                      <Copy className="size-3 shrink-0" /> {stray.abs}
                    </span>
                  )}
                </button>
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <div className="space-y-2">
        {models.map((model) => {
          const primary = model.files.find((item) => item.role === 'primary');
          const companions = model.files.filter((item) => item.role !== 'primary');
          const confirming = confirmId === model.id;
          const checked = selected.has(model.id);
          return (
            <Card key={model.id} className={cn('overflow-hidden', confirming && 'ring-1 ring-destructive/40')}>
              <CardContent className="flex flex-wrap items-start gap-3 p-3.5">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(value) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (value === true) next.add(model.id);
                      else next.delete(model.id);
                      return next;
                    })
                  }
                  className="mt-0.5"
                  aria-label={`选择 ${model.name}`}
                />

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-sm font-medium">{model.name}</span>
                    {model.legacy ? (
                      <Badge
                        variant="outline"
                        className="h-5 border-amber-500/40 text-[10px] font-normal text-amber-700 dark:text-amber-400"
                      >
                        旧位置
                      </Badge>
                    ) : null}
                    {model.duplicate_of ? (
                      <Badge
                        variant="outline"
                        className="h-5 border-destructive/40 text-[10px] font-normal text-destructive"
                      >
                        疑似重复
                      </Badge>
                    ) : null}
                    {model.incomplete ? (
                      <Badge
                        variant="outline"
                        className="h-5 border-amber-500/40 text-[10px] font-normal text-amber-700 dark:text-amber-400"
                      >
                        缺 {model.missing.join('、')}
                      </Badge>
                    ) : null}
                    {(model.meta.tags ?? []).map((tag) => (
                      <Badge key={tag} variant="secondary" className="h-5 text-[10px] font-normal">
                        {tag}
                      </Badge>
                    ))}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="font-mono">{primary?.name ?? model.raw_name}</span>
                    <span>·</span>
                    <span>{formatBytes(model.bytes)}</span>
                    {companions.length > 0 ? (
                      <>
                        <span>·</span>
                        <span>配套 {companions.length} 个（{companions.map((item) => item.name).join('、')}）</span>
                      </>
                    ) : null}
                    <span>·</span>
                    <span className="font-mono opacity-70">{model.rel_dir === '.' ? '（根目录）' : model.rel_dir}</span>
                  </div>

                  {model.meta.note ? (
                    <p className="line-clamp-1 text-[11px] text-muted-foreground">备注：{model.meta.note}</p>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {confirming ? (
                    <>
                      <Button
                        size="sm"
                        variant="destructive"
                        className="h-7 text-xs"
                        disabled={busyId === model.id}
                        onClick={() => void handleDelete(model)}
                      >
                        {busyId === model.id ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
                        确认删除
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmId(null)}>
                        取消
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground"
                        onClick={() => setEditing(model)}
                        aria-label={`编辑 ${model.name}`}
                        title="编辑（重命名 / 显示名 / 备注）"
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="text-muted-foreground hover:text-destructive"
                        onClick={() => void handleDelete(model)}
                        aria-label={`删除 ${model.name}`}
                        title="删除（含配套文件）"
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <ModelEditDialog
        model={editing}
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        onSaved={() => {
          void refresh();
          onChanged?.();
        }}
      />

      <BatchRenameDialog
        open={renameOpen}
        models={selectedModels}
        onOpenChange={setRenameOpen}
        onDone={async () => {
          setSelected(new Set());
          await refresh();
          onChanged?.();
        }}
      />

      <MigrationDialog
        plan={migratePlan}
        running={migrating}
        onOpenChange={(open) => {
          if (!open) setMigratePlan(null);
        }}
        onConfirm={() => void runMigrate()}
      />
    </div>
  );
}

// --------------------------------------------------------------------------
// 批量重命名
// --------------------------------------------------------------------------

type RenameMode = 'prefix' | 'suffix' | 'replace';

const RENAME_MODE_LABEL: Record<RenameMode, string> = {
  prefix: '加前缀',
  suffix: '加后缀',
  replace: '查找替换',
};

/** 按模式算出一个新名字（不落盘，只用于预览） */
function applyRename(mode: RenameMode, value: string, find: string, original: string): string {
  if (mode === 'prefix') return `${value}${original}`;
  if (mode === 'suffix') return `${original}${value}`;
  if (!find) return original;
  return original.split(find).join(value);
}

/**
 * 批量重命名。
 *
 * **必须预览**：RVC / DDSP-SVC 的改名会联动改 2 个文件（`.pth` + `.index`、
 * `.pt` + `config.yaml`），用户点下去之前要看到「谁变成谁」。
 * 同时预检重名，避免改到一半失败留下半套文件。
 */
function BatchRenameDialog({
  open,
  models,
  onOpenChange,
  onDone,
}: {
  open: boolean;
  models: ModelEntry[];
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const [mode, setMode] = useState<RenameMode>('prefix');
  const [value, setValue] = useState('');
  const [find, setFind] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setMode('prefix');
      setValue('');
      setFind('');
    }
  }, [open]);

  const preview = useMemo(
    () =>
      models.map((model) => ({
        id: model.id,
        from: model.raw_name,
        to: applyRename(mode, value, find, model.raw_name),
        companions: model.files.filter((item) => item.role !== 'primary').map((item) => item.name),
      })),
    [find, mode, models, value],
  );

  const dupTargets = useMemo(() => {
    const seen = new Map<string, number>();
    for (const item of preview) seen.set(item.to, (seen.get(item.to) ?? 0) + 1);
    return new Set([...seen.entries()].filter(([, count]) => count > 1).map(([name]) => name));
  }, [preview]);

  const changed = preview.filter((item) => item.from !== item.to);
  const blocked = dupTargets.size > 0 || changed.some((item) => !item.to.trim());

  const handleRun = async () => {
    setSaving(true);
    const failed: string[] = [];
    try {
      for (const item of changed) {
        try {
          await modelsApi.rename(item.id, item.to);
        } catch (error) {
          failed.push(`${item.from}：${(error as RequestError).message}`);
        }
      }
      if (failed.length === 0) {
        toast.success(`已重命名 ${changed.length} 个模型`);
      } else {
        toast.warning(`完成：成功 ${changed.length - failed.length}，失败 ${failed.length}`, {
          description: failed.slice(0, 3).join('\n'),
        });
      }
      onOpenChange(false);
      await onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>批量重命名（{models.length} 个）</DialogTitle>
          <DialogDescription>
            配套文件（.index / config.yaml）会一起改名。确认下面的对照表再执行。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-32 space-y-1.5">
              <Label className="text-xs">方式</Label>
              <Select value={mode} onValueChange={(next) => setMode(next as RenameMode)}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(RENAME_MODE_LABEL) as RenameMode[]).map((key) => (
                    <SelectItem key={key} value={key}>
                      {RENAME_MODE_LABEL[key]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {mode === 'replace' ? (
              <div className="min-w-[120px] flex-1 space-y-1.5">
                <Label className="text-xs">查找</Label>
                <Input value={find} onChange={(event) => setFind(event.target.value)} className="h-9" />
              </div>
            ) : null}
            <div className="min-w-[140px] flex-1 space-y-1.5">
              <Label className="text-xs">{mode === 'replace' ? '替换为' : '内容'}</Label>
              <Input
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder={mode === 'prefix' ? '例如 MYGO_' : mode === 'suffix' ? '例如 _v2' : ''}
                className="h-9"
              />
            </div>
          </div>

          <div className="max-h-72 overflow-y-auto rounded-md border">
            <table className="w-full text-[11px]">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                <tr className="text-left">
                  <th className="px-2.5 py-1.5 font-medium">原名</th>
                  <th className="px-2.5 py-1.5 font-medium">新名</th>
                  <th className="px-2.5 py-1.5 font-medium">联动文件</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((item) => {
                  const isDup = dupTargets.has(item.to);
                  const unchanged = item.from === item.to;
                  return (
                    <tr key={item.id} className="border-t">
                      <td className="px-2.5 py-1.5 font-mono">{item.from}</td>
                      <td
                        className={cn(
                          'px-2.5 py-1.5 font-mono',
                          isDup && 'text-destructive',
                          unchanged && 'text-muted-foreground',
                        )}
                      >
                        {item.to || '(空)'}
                        {isDup ? ' ← 重名' : ''}
                      </td>
                      <td className="px-2.5 py-1.5 text-muted-foreground">
                        {item.companions.length > 0 ? item.companions.join('、') : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {blocked ? (
            <p className="text-[11px] text-destructive">存在重名或空名称，请先调整规则。</p>
          ) : (
            <p className="text-[11px] text-muted-foreground">将改动 {changed.length} 个模型。</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleRun()} disabled={saving || blocked || changed.length === 0}>
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            执行重命名
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------
// 迁移
// --------------------------------------------------------------------------

/** 迁移确认弹窗：先把计划摊开（来源 → 目标），确认后才真搬。 */
function MigrationDialog({
  plan,
  running,
  onOpenChange,
  onConfirm,
}: {
  plan: MigrationPlan | null;
  running: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={plan !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>迁移到规范目录</DialogTitle>
          <DialogDescription>
            把兼容旧位置里的模型搬到规范目录，保留原有的目录结构（不拍平）。目标已存在同名文件的一律跳过，绝不覆盖。
          </DialogDescription>
        </DialogHeader>

        {plan ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span>
                共 <span className="font-medium">{plan.total}</span> 个
              </span>
              <span className="text-emerald-600 dark:text-emerald-400">
                可迁移 <span className="font-medium">{plan.will_move}</span>
              </span>
              {plan.blocked > 0 ? (
                <span className="text-amber-600 dark:text-amber-400">
                  冲突跳过 <span className="font-medium">{plan.blocked}</span>
                </span>
              ) : null}
            </div>

            <div className="max-h-72 overflow-y-auto rounded-md border">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-muted/80 backdrop-blur">
                  <tr className="text-left">
                    <th className="px-2.5 py-1.5 font-medium">模型</th>
                    <th className="px-2.5 py-1.5 font-medium">从</th>
                    <th className="px-2.5 py-1.5 font-medium">到</th>
                  </tr>
                </thead>
                <tbody>
                  {plan.items.map((item, index) => (
                    <tr key={`${item.name}-${index}`} className="border-t">
                      <td className="px-2.5 py-1.5">{item.name}</td>
                      <td className="px-2.5 py-1.5 font-mono text-muted-foreground">
                        {item.from.split(/[\\/]models[\\/]/).pop() ?? item.from}
                      </td>
                      <td
                        className={cn(
                          'px-2.5 py-1.5 font-mono',
                          item.conflict
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-emerald-600 dark:text-emerald-400',
                        )}
                      >
                        {item.conflict ? '跳过（目标已存在）' : (item.to.split(/[\\/]models[\\/]/).pop() ?? item.to)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <p className="text-[11px] text-muted-foreground">
              旧位置仍在兼容读取列表里，所以迁移过程中模型不会「消失」。
            </p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            取消
          </Button>
          <Button onClick={onConfirm} disabled={running || !plan || plan.will_move === 0}>
            {running ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            执行迁移
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
