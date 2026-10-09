/**
 * 统一模型管理客户端（网关原生接口 `/api/models/*`）。
 *
 * 为什么不在各引擎页各写一套：改前 RVC / DDSP-SVC / GPT-SoVITS 的模型列表
 * 分别来自三个 Python 端点，形状与错误码都不一样，且没有一个能跨类别统一管理。
 * 现在文件与清单都在网关侧（`server/src/services/modelRegistry.ts`），
 * 前端只需要这一个客户端。
 *
 * 与 `voices.ts`（参考音频）的关系：两者**并列**，不是替代 ——
 * 参考音频是零样本三引擎共用的素材，模型文件是各引擎私有的权重。
 * 详见 `docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §4.4 的能力矩阵。
 */
import { RequestError } from '@/lib/errors';

export const MODELS_BASE = '/api/models';

/** 类别（与后端 `MODEL_CATEGORIES` 一一对应） */
export type ModelCategoryKey = 'rvc' | 'ddsp-svc' | 'gpt-sovits' | 'netease';

export interface ModelFile {
  name: string;
  /** 相对模型根目录的路径（`/` 分隔） */
  rel: string;
  abs: string;
  bytes: number;
  role: 'primary' | 'companion' | 'required';
}

export interface ModelEntry {
  id: string;
  category: string;
  /** 显示名（sidecar 的 display_name 优先，其次子目录名，最后文件名） */
  name: string;
  raw_name: string;
  /** 相对**所在搜索根**的目录；根目录本身为 `.` */
  rel_dir: string;
  /** 所在搜索根的绝对路径 */
  root: string;
  /** true = 来自兼容读取的旧位置，界面应提示「建议迁移」 */
  legacy: boolean;
  files: ModelFile[];
  bytes: number;
  updated_at: number;
  /** 缺必需配套文件（如 DDSP-SVC 的 config.yaml） */
  incomplete: boolean;
  missing: string[];
  /** sidecar `.meta.json` 的内容；服务端总是返回对象（没有就是 `{}`） */
  meta: ModelMeta;
  /** 疑似重复：与另一个模型主权重同名同大小 */
  duplicate_of?: string;
}

export interface ModelCategoryView {
  key: ModelCategoryKey;
  label: string;
  hint: string;
  /** 规范根目录（用户要手动放文件就放这里） */
  dir: string;
  exists: boolean;
  /** 兼容读取的旧位置（已过滤为存在的） */
  legacy_dirs: string[];
  count: number;
  /** 预留类别：目录存在但功能未接入 */
  reserved?: string;
}

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> {
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response: Response;
  try {
    response = await fetch(`${MODELS_BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new RequestError(504, { code: 'MODELS_TIMEOUT', message: '模型列表请求超时', retryable: true });
    }
    throw new RequestError(0, {
      code: 'MODELS_UNREACHABLE',
      message: '无法连接网关的模型管理接口',
      retryable: true,
      hint: '确认网关在跑（npm run dev 或 start.bat）。模型管理由网关直接提供，不需要任何模型服务。',
    });
  } finally {
    if (timer) clearTimeout(timer);
  }

  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const maybe = payload as
      | {
          error?: { code: string; message: string; retryable?: boolean; hint?: string };
          conflict?: ImportConflict;
        }
      | null;
    const errorBody = maybe?.error ?? {
      code: `HTTP_${response.status}`,
      message: text?.slice(0, 300) || `网关返回 ${response.status}`,
      retryable: response.status >= 500,
    };
    // 409 的冲突详情挂到 `details` 上，调用方用 `conflictOf()` 取
    throw new RequestError(response.status, { ...errorBody, details: maybe?.conflict });
  }
  return payload as T;
}

export const modelsApi = {
  /** 类别总览：Tab 标题、计数、规范根目录与兼容旧位置 */
  catalog: (): Promise<{ ok: boolean; root: string; categories: ModelCategoryView[] }> =>
    request('/catalog', { method: 'GET' }),

  /** 单类模型列表（每次都实时扫盘，所以本地拖入文件后重新调用即可看到） */
  list: (category: ModelCategoryKey): Promise<{ ok: boolean; models: ModelEntry[]; total: number }> =>
    request(`/?category=${encodeURIComponent(category)}`, { method: 'GET' }),

  /** 删除一个模型（含全部配套文件） */
  remove: (id: string): Promise<{ ok: boolean; removed: string[]; message: string }> =>
    request(`/?id=${encodeURIComponent(id)}`, { method: 'DELETE', body: JSON.stringify({ id }) }),

  /** 在文件管理器里打开该类别的目录 */
  reveal: (category: ModelCategoryKey): Promise<{ ok: boolean; dir: string; message: string }> =>
    request('/reveal', { method: 'POST', body: JSON.stringify({ category }) }),

  /**
   * 上传一个模型文件。
   *
   * 走**原始字节 + 查询参数**（与 `/api/voicelib` 同一取舍，网关没装 multipart 解析器）。
   * 逐文件调用，这样：① 能给出准确进度；② 一个文件夹拖进来 = 多次调用、各自带相对路径，
   * 从而**保留目录结构**（不拍平）。
   *
   * 冲突时后端返回 409，`conflict` 字段带详情；调用方据此决定是否改用 `keep_both` 重试。
   */
  importFile: (
    category: ModelCategoryKey,
    file: File,
    opts: { subdir?: string; onConflict?: 'reject' | 'overwrite' | 'keep_both' } = {},
  ): Promise<ModelImportResult> =>
    request(
      (() => {
        const params = new URLSearchParams({
          category,
          filename: file.name,
        });
        if (opts.subdir) params.set('subdir', opts.subdir);
        if (opts.onConflict) params.set('on_conflict', opts.onConflict);
        return `/import?${params.toString()}`;
      })(),
      {
        method: 'POST',
        body: file,
        headers: { 'Content-Type': 'application/octet-stream' },
      },
      // 模型可能几百 MB，超时按大小放宽（最少 60s）
      60_000 + Math.ceil(file.size / 1024 / 1024) * 1_000,
    ),

  /** 重命名（联动配套文件） */
  rename: (id: string, name: string): Promise<{ ok: boolean; renamed: string[]; new_id: string; name: string }> =>
    request('/rename', { method: 'POST', body: JSON.stringify({ id, name }) }),

  /** 写 sidecar 元数据 */
  update: (
    id: string,
    patch: { display_name?: string; note?: string; tags?: string[] },
  ): Promise<{ ok: boolean; meta: ModelMeta }> =>
    request('/update', { method: 'POST', body: JSON.stringify({ id, ...patch }) }),

  /** 迁移计划（只读） */
  migratePlan: (category: ModelCategoryKey): Promise<MigrationPlan> =>
    request('/migrate', { method: 'POST', body: JSON.stringify({ category }) }),

  /** 执行迁移 */
  migrateRun: (category: ModelCategoryKey): Promise<MigrationResult> =>
    request('/migrate', { method: 'POST', body: JSON.stringify({ category, dry_run: false }) }, 120_000),
};

export interface ModelMeta {
  display_name?: string;
  note?: string;
  tags?: string[];
  origin?: string;
  created_at?: number;
}

export interface ImportConflict {
  existing: { id: string; name: string; rel: string; bytes: number };
  incoming: { name: string; rel: string; bytes: number };
}

export interface ModelImportResult {
  ok: true;
  rel: string;
  abs: string;
  bytes: number;
  renamed_to?: string;
  warnings: string[];
}

export interface MigrationItem {
  from: string;
  to: string;
  name: string;
  bytes: number;
  conflict: boolean;
  files: string[];
}

export interface MigrationPlan {
  ok: boolean;
  dry_run: true;
  legacy_roots: string[];
  total: number;
  will_move: number;
  blocked: number;
  items: MigrationItem[];
}

export interface MigrationResult {
  ok: boolean;
  dry_run: false;
  moved: { name: string; from: string; to: string; files: number }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
}

/** 从 409 响应里取冲突详情（其余错误返回 null） */
export function conflictOf(error: unknown): ImportConflict | null {
  if (!(error instanceof RequestError) || error.status !== 409) return null;
  return (error.details as ImportConflict | undefined) ?? null;
}


export function formatBytes(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
