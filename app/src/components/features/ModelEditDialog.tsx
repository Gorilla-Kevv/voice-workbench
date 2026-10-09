import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
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
import { Textarea } from '@/components/ui/textarea';
import { RequestError } from '@/lib/errors';
import { modelsApi, type ModelEntry } from '@/lib/models';

/**
 * 编辑一个模型：**重命名**（联动配套文件）+ **元数据**（显示名 / 备注 / 标签）。
 *
 * 为什么「显示名」和「文件名」是两个字段：
 *   * 文件名是事实（要跟 `.index` / `config.yaml` 配对，也可能被引擎直接引用）；
 *   * 显示名是给人看的（`lenai.pth` 在界面上叫「乐奈」更好认）。
 * 所以重命名改文件名、显示名写 sidecar，互不干扰。
 */
interface ModelEditDialogProps {
  model: ModelEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function ModelEditDialog({ model, open, onOpenChange, onSaved }: ModelEditDialogProps) {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [note, setNote] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!model) return;
    setName(model.raw_name);
    setDisplayName(model.meta.display_name ?? '');
    setNote(model.meta.note ?? '');
    setTags((model.meta.tags ?? []).join(', '));
  }, [model]);

  if (!model) return null;

  const companions = model.files.filter((item) => item.role !== 'primary');
  const nameChanged = name.trim() !== model.raw_name;
  const metaChanged =
    displayName.trim() !== (model.meta.display_name ?? '') ||
    note.trim() !== (model.meta.note ?? '') ||
    tags.trim() !== (model.meta.tags ?? []).join(', ');

  const handleSave = async () => {
    setSaving(true);
    try {
      if (nameChanged) {
        const result = await modelsApi.rename(model.id, name.trim());
        if (result.renamed.length > 0) {
          toast.success(`已重命名为「${result.name}」`, {
            description: `联动改名的文件：${result.renamed.map((rel) => rel.split('/').pop()).join('、')}`,
          });
        }
      }
      if (metaChanged) {
        await modelsApi.update(model.id, {
          display_name: displayName,
          note,
          tags: tags.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
        });
        toast.success('已保存显示信息');
      }
      onOpenChange(false);
      onSaved();
    } catch (error) {
      toast.error('保存失败', { description: (error as RequestError).fullMessage });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>编辑模型</DialogTitle>
          <DialogDescription>
            文件名会连同配套文件一起改；显示名与备注只影响界面。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="model-name" className="text-xs">
              文件名
            </Label>
            <Input
              id="model-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="h-9"
            />
            {nameChanged && companions.length > 0 ? (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                将一并改名：{companions.map((item) => item.name).join('、')}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-display" className="text-xs">
              显示名（留空则用文件名）
            </Label>
            <Input
              id="model-display"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              placeholder={model.raw_name}
              className="h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-tags" className="text-xs">
              标签（逗号分隔）
            </Label>
            <Input
              id="model-tags"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              placeholder="mygo, anime"
              className="h-9"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="model-note" className="text-xs">
              备注
            </Label>
            <Textarea
              id="model-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              placeholder="来源、版本、训练参数…"
            />
          </div>

          <div className="rounded-md bg-muted/50 px-2.5 py-2 text-[11px] text-muted-foreground">
            <p className="font-mono">{model.rel_dir === '.' ? '（类别根目录）' : model.rel_dir}</p>
            <p className="mt-0.5">{model.files.map((item) => item.name).join('、')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={saving || (!nameChanged && !metaChanged)}>
            {saving ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : null}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
