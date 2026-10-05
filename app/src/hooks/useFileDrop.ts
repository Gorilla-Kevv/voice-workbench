import { useCallback, useEffect, useRef, useState } from 'react';
import type { DragEvent, DragEventHandler, RefObject } from 'react';

/**
 * 文件 / 文件夹拖拽导入的共用底座。
 *
 * 为什么要有它：全站十多个上传点原先只认 `<input type=file>`，鼠标把文件或整个文件夹
 * 拖过来没有任何反应 —— 用户要么去点按钮、要么先把文件夹打开再多选，而「拖一个语料目录进来」
 * 本来就是训练页最自然的动作。
 *
 * 两个不显然的点：
 * 1. **文件夹必须走 `webkitGetAsEntry`**。`dataTransfer.files` 对目录只给出一个 0 字节的壳，
 *    内容要顺着 entry 异步读出来；浏览器不允许同步拿到路径，所以「拖目录」= 递归取里面的文件。
 * 2. **dragleave 会因子元素反复触发**，用一个深度计数器决定何时收掉高亮，否则拖拽时边框会闪。
 */

/** `accept` 的写法与 `<input accept>` 一致：`audio/*`、`.wav`、`text/csv` 可混排 */
function matchesAccept(file: File, accept?: string): boolean {
  if (!accept) return true;
  const patterns = accept.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (patterns.length === 0) return true;
  const name = file.name.toLowerCase();
  const type = (file.type || '').toLowerCase();
  return patterns.some((pattern) => {
    if (pattern.startsWith('.')) return name.endsWith(pattern);
    if (pattern.endsWith('/*')) return type.startsWith(pattern.slice(0, -1));
    return type === pattern;
  });
}

interface FsFileEntry {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (ok: (file: File) => void, err?: (e: unknown) => void) => void;
}
interface FsDirEntry {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => { readEntries: (ok: (entries: FsEntryLike[]) => void, err?: (e: unknown) => void) => void };
}
type FsEntryLike = FsFileEntry | FsDirEntry;

/** 目录条目一次只回一小批，读到空为止（官方语义：返回 0 条才算完） */
async function readDirectory(entry: FsDirEntry): Promise<FsEntryLike[]> {
  const reader = entry.createReader();
  const collected: FsEntryLike[] = [];
  while (true) {
    const batch = await new Promise<FsEntryLike[]>((resolve) =>
      reader.readEntries((entries) => resolve(entries as FsEntryLike[]), () => resolve([])),
    );
    if (batch.length === 0) return collected;
    collected.push(...batch);
  }
}

async function collect(entry: FsEntryLike, out: File[]): Promise<void> {
  if (entry.isFile) {
    await new Promise<void>((resolve) => {
      entry.file(
        (file) => {
          out.push(file);
          resolve();
        },
        () => resolve(),
      );
    });
    return;
  }
  const children = await readDirectory(entry);
  await Promise.all(children.map((child) => collect(child, out)));
}

/** 从一次拖放里取出所有文件（含文件夹内的）；老浏览器没有 entry API 时退回 files */
async function filesFromTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const asEntry = dataTransfer.items?.[0]?.webkitGetAsEntry as (() => FsEntryLike | null) | undefined;
  if (typeof asEntry !== 'function') return Array.from(dataTransfer.files);
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item.kind === 'file' ? item.webkitGetAsEntry() as FsEntryLike | null : null))
    .filter((entry): entry is FsEntryLike => entry !== null);
  if (entries.length === 0) return Array.from(dataTransfer.files);
  const out: File[] = [];
  await Promise.all(entries.map((entry) => collect(entry, out)));
  return out;
}

export interface FileDropOptions {
  /** 收到（并按 accept 过滤好的）文件时回调；单选场景自己取 `files[0]` */
  onFiles: (files: File[]) => void;
  /** 与 `<input accept>` 同语法；拖进来的不符类型会被忽略 */
  accept?: string;
  /** false 时只给第一个符合的文件 */
  multiple?: boolean;
  /** 上传中 / 服务不可用时可以先关掉拖拽，避免和按钮抢同一件事 */
  disabled?: boolean;
  /**
   * 传给页面上那个 `<input type=file>`：拖放完成后把文件回填进 `input.files`。
   * 不回填的话，用原生控件显示文件名的地方会一直写着「未选择任何文件」，看着像没成功。
   */
  inputRef?: RefObject<HTMLInputElement | null>;
}

export interface FileDropState {
  dragging: boolean;
  /** 直接展开到承载拖放的容器上（div / label / Card 皆可） */
  rootProps: {
    onDragOver: DragEventHandler<HTMLElement>;
    onDragEnter: DragEventHandler<HTMLElement>;
    onDragLeave: DragEventHandler<HTMLElement>;
    onDrop: DragEventHandler<HTMLElement>;
  };
}

/**
 * 把一批文件塞进 `<input type=file>` 的 `files`。
 * 拖放与程序化赋值都走这里 —— 原生控件靠 `input.files` 显示文件名，
 * 不回填就会一直写着「未选择任何文件」，看着像没成功。
 */
export function applyFilesToInput(input: HTMLInputElement, files: File[]): void {
  try {
    const transfer = new DataTransfer();
    files.forEach((file) => transfer.items.add(file));
    input.files = transfer.files;
  } catch {
    // 回填只是显示用，失败也不影响本次选择已经生效
  }
}

export function useFileDrop({
  onFiles,
  accept,
  multiple = false,
  disabled = false,
  inputRef,
}: FileDropOptions): FileDropState {
  const [dragging, setDragging] = useState(false);
  /** 进入深度：> 0 表示指针在当前容器（含子元素）之内 */
  const depth = useRef(0);
  const onFilesRef = useRef(onFiles);
  // 拖放回调在事件里执行，用 effect 保最新引用（渲染期写 ref 是 React 19 的禁止项）
  useEffect(() => {
    onFilesRef.current = onFiles;
  }, [onFiles]);

  const handleDrop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      void filesFromTransfer(event.dataTransfer).then((all) => {
        const files = accept ? all.filter((file) => matchesAccept(file, accept)) : all;
        // 拖进来一批但这里只收一个时：给第一个，并让调用方自己决定是否提示
        if (files.length === 0) return;
        onFilesRef.current(multiple ? files : files.slice(0, 1));
        const input = inputRef?.current;
        if (input) applyFilesToInput(input, files);
      });
    },
    [accept, disabled, inputRef, multiple],
  );

  return {
    dragging,
    rootProps: {
      onDragOver: (event) => {
        if (disabled) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      },
      onDragEnter: (event) => {
        if (disabled) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      },
      onDrop: handleDrop,
    },
  };
}

/** 拖拽高亮的统一观感：常态由调用方给边框，拖进来时换成 violet */
export function dropHighlight(dragging: boolean): string {
  return dragging ? 'border-violet-500 bg-violet-500/5 ring-1 ring-violet-400/40' : '';
}
