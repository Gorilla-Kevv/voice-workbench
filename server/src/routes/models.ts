/**
 * 统一模型管理接口（`/api/models/*`，网关原生实现，不依赖任何 Python 服务）。
 *
 * 存在理由与 `/api/voicelib` 同源：模型列表曾分散在四个 Python 端点里
 * （RVC `/v1/vc/catalog`、DDSP-SVC `/v1/svc/catalog`、GPT-SoVITS `/v1/weights`），
 * 形状与错误码各不相同，且**没有一个能跨类别统一管理**。
 * 现在文件与清单都由网关直接管（见 `services/modelRegistry.ts`），
 * Python 侧只保留「加载进显存」这一类必须由持有引擎做的事。
 *
 * P0 阶段只提供**只读 + 删除 + 打开目录**；
 * 导入 / 重命名 / 元数据编辑在 P1 接（见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §10）。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Request, type Response, type Router as RouterType } from 'express';
import { Router } from 'express';
import {
  ModelImportConflict,
  ModelRegistryError,
  MODELS_ROOT,
  deleteModel,
  ensureCategoryDir,
  findCategory,
  importModel,
  listCategories,
  listModels,
  modelsSummary,
  planMigration,
  renameModel,
  runMigration,
  updateModelMeta,
  type ConflictPolicy,
} from '../services/modelRegistry.js';

export const modelsRouter: RouterType = Router();

function sendError(res: Response, error: unknown): void {
  if (error instanceof ModelImportConflict) {
    res.status(409).json({
      ok: false,
      error: { code: error.code, message: error.message, retryable: false, hint: error.hint },
      conflict: error.conflict,
    });
    return;
  }
  if (error instanceof ModelRegistryError) {
    res.status(error.status).json({
      ok: false,
      error: { code: error.code, message: error.message, retryable: false, hint: error.hint },
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  res.status(500).json({
    ok: false,
    error: {
      code: 'MODELS_FAILED',
      message,
      retryable: true,
      hint: `检查模型根目录是否可读：${MODELS_ROOT}`,
    },
  });
}

/** 类别总览：Tab 标题、计数、规范根目录与兼容旧位置 */
modelsRouter.get('/catalog', (_req: Request, res: Response) => {
  try {
    res.json({ ok: true, root: MODELS_ROOT, categories: listCategories() });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * 模型列表。
 *
 * `?category=` 必填（不传就返回全部类别的合并结果，便于产出记录页一次性拉全）。
 * **每次都实时扫盘** —— 这是「本地拖文件进文件夹后刷新页面就能看到」得以成立的前提，
 * 也是刻意不缓存的原因（本地场景只有几十个文件，重扫比维护缓存便宜且不会脏）。
 */
modelsRouter.get('/', (req: Request, res: Response) => {
  try {
    const category = typeof req.query.category === 'string' ? req.query.category.trim() : '';
    if (category) {
      const models = listModels(category);
      res.json({ ok: true, category, models, total: models.length });
      return;
    }
    const all = listCategories().flatMap((item) => (item.reserved ? [] : listModels(item.key)));
    all.sort((a, b) => b.updated_at - a.updated_at);
    res.json({ ok: true, category: null, models: all, total: all.length });
  } catch (error) {
    sendError(res, error);
  }
});

/** 删除一个模型（含全部配套文件，边界检查在 service 层） */
modelsRouter.delete('/', express.json(), (req: Request, res: Response) => {
  try {
    const id = typeof req.query.id === 'string' ? req.query.id : String((req.body ?? {}).id ?? '');
    if (!id) {
      throw new ModelRegistryError(400, 'MODEL_ID_REQUIRED', '缺少模型 id', '列表里的每个模型都有 id。');
    }
    const { removed } = deleteModel(id);
    res.json({ ok: true, removed, message: `已删除 ${removed.length} 个文件` });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * 在资源管理器里打开某个类别的目录。
 *
 * **只接受注册表里的 category key**，路径由服务端拼 ——
 * 不接受任意路径，否则就是一个「打开任意目录」的安全口子。
 */
modelsRouter.post('/reveal', express.json(), (req: Request, res: Response) => {
  try {
    const key = String((req.body ?? {}).category ?? '').trim();
    const spec = findCategory(key);
    const dir = ensureCategoryDir(spec);

    if (process.platform === 'win32') {
      // explorer 打开成功也会返回非 0 退出码，所以不校验结果
      execFile('explorer', [dir], { windowsHide: false, stdio: 'ignore' } as never, () => {});
    } else {
      const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
      execFile(opener, [dir], { stdio: 'ignore' } as never, () => {});
    }
    res.json({ ok: true, dir, message: `已在文件管理器打开 ${path.basename(dir)}` });
  } catch (error) {
    sendError(res, error);
  }
});

/** 给 `/health` 与设置页展示 */
export function modelsSummaryForHealth() {
  return modelsSummary();
}

// --------------------------------------------------------------------------
// 写操作（P1）
// --------------------------------------------------------------------------

/**
 * 上传体积上限。
 *
 * 为什么给到 2 GB：RVC 的 `.index` 实测有 440 MB 的（`MYGO全员/立希/lixi.index`），
 * 而参考音频那套的 64 MB 上限显然不够。仍设上限是为了挡住误传的巨型文件。
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

/** 导入暂存目录：**必须与 models/ 同盘**，否则 `renameSync` 会退化成跨盘复制 */
const IMPORT_TMP_DIR = path.join(MODELS_ROOT, '.tmp-import');

/** 把请求体流式写进临时文件，返回 (路径, 字节数)。避免把几百 MB 读进内存。 */
function streamToTemp(req: Request, filename: string): Promise<{ tempPath: string; bytes: number }> {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(IMPORT_TMP_DIR, { recursive: true });
    const tempPath = path.join(IMPORT_TMP_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(filename)}`);
    const out = fs.createWriteStream(tempPath);
    let bytes = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      out.destroy();
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // 临时文件可能还没建出来
      }
      reject(error);
    };

    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) {
        fail(
          new ModelRegistryError(
            413,
            'MODEL_UPLOAD_TOO_LARGE',
            `文件超过 ${(MAX_UPLOAD_BYTES / 1024 / 1024 / 1024).toFixed(0)} GB 上限`,
          ),
        );
        return;
      }
      if (!out.write(chunk)) req.pause();
    });
    out.on('drain', () => req.resume());
    req.on('error', fail);
    out.on('error', fail);
    req.on('end', () => {
      out.end(() => {
        if (settled) return;
        settled = true;
        resolve({ tempPath, bytes });
      });
    });
  });
}

/**
 * 导入一个模型文件。
 *
 * 走**原始字节 + 查询参数**而不是 multipart：网关没装 multipart 解析器
 * （与 `/api/voicelib` 同一取舍），而且逐文件 POST 能让前端给出准确的进度，
 * 也天然支持「一个文件夹拖进来 = 多次 POST，各自带相对路径」。
 *
 * `on_conflict`：`reject`（默认，返回 409 + 冲突详情）/ `overwrite` / `keep_both`。
 */
modelsRouter.post('/import', async (req: Request, res: Response) => {
  const q = req.query as Record<string, string | undefined>;
  let tempPath: string | null = null;
  try {
    const spec = findCategory((q.category ?? '').trim());
    const filename = (q.filename ?? '').trim();
    if (!filename) {
      throw new ModelRegistryError(400, 'MODEL_FILENAME_REQUIRED', '缺少 filename 查询参数');
    }
    // **先校验扩展名再收流**：既省掉一次无谓的大文件上传，
    // 也不会在暂存目录留下垃圾（实测踩过：被拒的 .exe 留下了临时文件）。
    const ext = path.extname(path.basename(filename)).toLowerCase();
    if (spec.allowed.length > 0 && !spec.allowed.includes(ext)) {
      throw new ModelRegistryError(
        400,
        'MODEL_FORMAT_UNSUPPORTED',
        `「${spec.label}」不接受 ${ext || '无扩展名'} 文件`,
        `可用格式：${spec.allowed.join('、')}`,
      );
    }
    const policy = (q.on_conflict ?? 'reject') as ConflictPolicy;
    if (!['reject', 'overwrite', 'keep_both'].includes(policy)) {
      throw new ModelRegistryError(400, 'MODEL_BAD_CONFLICT_POLICY', `未知的冲突策略：${policy}`);
    }

    const streamed = await streamToTemp(req, filename);
    tempPath = streamed.tempPath;

    const result = importModel(spec, {
      subdir: q.subdir,
      filename,
      tempPath,
      onConflict: policy,
    });
    tempPath = null; // 已被 importModel 移走
    res.json(result);
  } catch (error) {
    // 失败时清掉临时文件，不留垃圾
    if (tempPath) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        // 已经被移走或不存在
      }
    }
    sendError(res, error);
  }
});

/** 重命名（联动配套文件） */
modelsRouter.post('/rename', express.json(), (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { id?: string; name?: string };
    if (!body.id) throw new ModelRegistryError(400, 'MODEL_ID_REQUIRED', '缺少模型 id');
    const result = renameModel(String(body.id), String(body.name ?? ''));
    res.json({ ok: true, ...result });
  } catch (error) {
    sendError(res, error);
  }
});

/** 写 sidecar 元数据（显示名 / 备注 / 标签） */
modelsRouter.post('/update', express.json(), (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { id?: string; display_name?: string; note?: string; tags?: unknown };
    if (!body.id) throw new ModelRegistryError(400, 'MODEL_ID_REQUIRED', '缺少模型 id');
    const meta = updateModelMeta(String(body.id), {
      display_name: body.display_name,
      note: body.note,
      tags: Array.isArray(body.tags) ? body.tags.map((tag) => String(tag)) : undefined,
    });
    res.json({ ok: true, meta });
  } catch (error) {
    sendError(res, error);
  }
});

/**
 * 迁移：把兼容旧位置里的模型收口到规范根。
 *
 * `dry_run: true` 时**只算不改**（默认就是 dry-run，要真搬必须显式传 `dry_run: false`）——
 * 移动文件是不可逆操作，默认必须是安全的那个方向。
 */
modelsRouter.post('/migrate', express.json(), (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as { category?: string; dry_run?: boolean };
    const key = String(body.category ?? '').trim();
    findCategory(key);

    const plan = planMigration(key);
    const willMove = plan.items.filter((item) => !item.conflict);
    const blocked = plan.items.filter((item) => item.conflict);

    if (body.dry_run !== false) {
      res.json({
        ok: true,
        dry_run: true,
        legacy_roots: plan.legacy_roots,
        total: plan.items.length,
        will_move: willMove.length,
        blocked: blocked.length,
        items: plan.items,
      });
      return;
    }

    const result = runMigration(key);
    res.json({
      ok: true,
      dry_run: false,
      moved: result.moved,
      skipped: result.skipped,
      failed: result.failed,
    });
  } catch (error) {
    sendError(res, error);
  }
});

