import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileAudio,
  FolderOpen,
  Loader2,
  Mic,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Trash2,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Textarea } from '@/components/ui/textarea';
import { formatBytes, formatDuration, formatRelativeTime } from '@/lib/audio';
import { RequestError } from '@/lib/errors';
import { resolveAudioUrl, sovitsApi } from '@/lib/sovits';
import type { SovitsCatalog, SovitsVoice } from '@/types';

/**
 * 音色库。
 *
 * 这个页面的存在本身就是 GPT-SoVITS 与「预置音色型」TTS 的分界线：
 * 它**没有任何内置音色**，一次零样本克隆需要「3~10 秒参考音频 + 这段音频的逐字转写」。
 * 把这两样东西绑定成一个可命名的实体、并常驻在本地，是把模型变成工具的关键一步 ——
 * 否则用户每次合成都得重新上传一遍。
 *
 * 页面上刻意做了三件事：
 *
 * 1. **直接回放参考音频**：合成质量差的最常见原因是素材本身不干净，
 *    而只看文件名是发现不了的；
 * 2. **前置警告**：时长不在 3~10 秒、缺转写文本这类问题会在合成前就标红，
 *    而不是等模型报错；
 * 3. **允许引用磁盘文件**：很多人的素材库已经在硬盘上了，没必要复制一份。
 */
export function VoiceLibraryPage() {
  const [voices, setVoices] = useState<SovitsVoice[]>([]);
  const [catalog, setCatalog] = useState<SovitsCatalog | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<SovitsVoice | null>(null);

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
        sovitsApi.listVoices(),
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
      // 必须兜底：FormData.append 会把 undefined 转成字符串 "undefined"，
      // 存进音色库后每次合成都会报「不支持合成语种 undefined」。
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
        ? await sovitsApi.createVoice(draft, file)
        : await sovitsApi.createVoiceFromPath({ ...draft, audio_path: externalPath.trim() });
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

  const handleUpdate = useCallback(async () => {
    if (!editing) return;
    setSubmitting(true);
    try {
      const result = await sovitsApi.updateVoice(editing.id, {
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
        await sovitsApi.replaceVoiceAudio(voice.id, next);
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

  const handleDelete = useCallback(
    async (voice: SovitsVoice) => {
      if (!window.confirm(`确定删除音色「${voice.name}」吗？此操作不可撤销。`)) return;
      try {
        await sovitsApi.deleteVoice(voice.id);
        toast.success('已删除');
        await load();
      } catch (err) {
        toast.error('删除失败', { description: (err as RequestError).fullMessage });
      }
    },
    [load],
  );

  const languages = catalog?.languages ?? [
    { id: 'zh', label: '中文' },
    { id: 'en', label: 'English' },
    { id: 'ja', label: '日本語' },
    { id: 'ko', label: '한국어' },
    { id: 'yue', label: '粤语' },
  ];

  const problemCount = useMemo(() => voices.filter((voice) => voice.warnings.length > 0).length, [voices]);

  if (error) {
    return (
      <Alert variant="destructive">
        <Server className="size-4" />
        <AlertTitle>GPT-SoVITS 本地服务不可用</AlertTitle>
        <AlertDescription className="space-y-2">
          <p>{error}</p>
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
          想获得更高相似度，可以到「模型训练」用 1 分钟以上的语料微调出专属权重。
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-3 space-y-0 pb-3">
          <div>
            <CardTitle className="text-base">音色库（{voices.length}）</CardTitle>
            <CardDescription>
              {problemCount > 0
                ? `${problemCount} 个音色存在会影响合成的问题，已标红`
                : '全部音色状态正常，可直接用于合成与批量合成'}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'size-3.5 animate-spin' : 'size-3.5'} />
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="mr-1.5 size-3.5" />
              导入音色
            </Button>
          </div>
        </CardHeader>
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
                导入一段 3~10 秒的干净人声即可开始零样本克隆
              </p>
              <Button size="sm" className="mt-4" onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1.5 size-3.5" />
                导入第一个音色
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {voices.map((voice) => (
                <div
                  key={voice.id}
                  className="space-y-3 rounded-lg border p-3.5"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">{voice.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                        <span>{voice.duration_s ? `${voice.duration_s.toFixed(1)} 秒` : '时长未知'}</span>
                        {voice.sample_rate ? <span>{voice.sample_rate} Hz</span> : null}
                        <span>{formatBytes(voice.size_bytes)}</span>
                        <Badge variant="secondary" className="h-4 px-1.5 font-mono text-[10px]">
                          {voice.origin === 'external' ? '引用磁盘' : '本地托管'}
                        </Badge>
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="icon" variant="ghost" className="size-7" onClick={() => setEditing(voice)}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="size-7 text-destructive hover:text-destructive"
                        onClick={() => void handleDelete(voice)}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  </div>

                  {voice.exists ? (
                    <audio
                      controls
                      preload="none"
                      className="h-8 w-full"
                      src={resolveAudioUrl(`/v1/voices/${voice.id}/audio`) ?? undefined}
                    />
                  ) : (
                    <p className="text-xs text-destructive">音频文件已丢失，请重新上传</p>
                  )}

                  <div className="space-y-1">
                    <p className="line-clamp-2 text-xs text-muted-foreground">
                      {voice.prompt_text ? `参考文本：${voice.prompt_text}` : '⚠️ 未填写参考文本'}
                    </p>
                    <p className="font-mono text-[10px] text-muted-foreground">
                      id: {voice.id} · {voice.prompt_lang} · 更新于 {formatRelativeTime(voice.updated_at * 1000)}
                    </p>
                  </div>

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
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- 新建 ---------------- */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>导入音色</DialogTitle>
            <DialogDescription>
              上传一段 3~10 秒的干净人声，并填写它的逐字转写文本。两者共同决定克隆效果。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="voice-name">音色名称</Label>
              <Input
                id="voice-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：播报男声-低沉"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="voice-file">参考音频</Label>
              <input
                ref={fileRef}
                type="file"
                accept="audio/*,.wav,.mp3,.flac,.ogg,.m4a,.webm,.aac,.wma"
                className="hidden"
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null;
                  setFile(next);
                  if (next) setExternalPath('');
                  event.target.value = '';
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
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
                参考音频需为 3~10 秒；相对路径按 GPT-SoVITS 根目录解析
              </p>
            </div>

            <Separator />

            <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
              <div className="space-y-2">
                <Label htmlFor="voice-prompt">参考文本（逐字转写）</Label>
                <Textarea
                  id="voice-prompt"
                  value={promptText}
                  onChange={(event) => setPromptText(event.target.value)}
                  placeholder="这段音频里实际说了什么，就写什么"
                  className="min-h-[72px]"
                />
                <p className="text-[11px] text-muted-foreground">
                  缺少参考文本会导致相似度明显下降，v3/v4 模型还会直接报错
                </p>
              </div>
              <div className="space-y-2">
                <Label>参考音频语种</Label>
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
                  <Label>参考文本</Label>
                  <Textarea
                    value={editing.prompt_text}
                    onChange={(event) => setEditing({ ...editing, prompt_text: event.target.value })}
                    className="min-h-[72px]"
                  />
                </div>
                <div className="space-y-2">
                  <Label>语种</Label>
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

              <div className="space-y-2">
                <Label>替换参考音频</Label>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(event) => {
                    const next = event.target.files?.[0];
                    if (next) void handleReplaceAudio(editing, next);
                    event.target.value = '';
                  }}
                  className="block w-full text-xs file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-xs"
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
        参考音频与转写文本全部保存在本机（默认位于 trainer/.data/voices），不会被上传到任何服务器。
        {voices.length > 0
          ? ` 当前音色总时长 ${formatDuration(
              voices.reduce((sum, voice) => sum + (voice.duration_s ?? 0), 0),
            )}。`
          : ''}
      </p>
    </div>
  );
}
