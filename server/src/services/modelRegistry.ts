/**
 * 统一模型注册表（网关侧实现）。
 *
 * ## 为什么要有这一层
 *
 * 改前四套模型列表各写各的、互不相通：
 *   * RVC        → `trainer/app/vc/models.py`（只扫一层 `*.pth`）
 *   * DDSP-SVC   → `trainer/app/svc/catalog.py`（扫两个目录）
 *   * GPT-SoVITS → `trainer/app/weights.py`（只有 `GET /v1/weights`）
 *   * 参考音频    → `services/voiceLibrary.ts`（唯一网关原生的一套）
 *
 * 后果是模型散落在 5 个位置、命名与嵌套规则互不一致，且
 * `models/RVC语音模型/MYGO全员/<角色>/` 那批**从未被任何扫描器看到**。
 *
 * 这里收敛成一套：**一个根目录 + 一张类别表 + 一个扫描器**。
 *
 * ## 两条设计约定（与 voiceLibrary 的方向相反，是刻意的）
 *
 * 1. **文件系统是事实源，清单只做覆盖层。**
 *    用户的主要操作是「把文件拖进文件夹」，所以扫描必须实时反映磁盘现状；
 *    显示名 / 备注 / 标签这类元数据放 sidecar `.meta.json`。
 *    （voiceLibrary 是索引优先 —— 参考音频由网页上传，先有记录再有文件，
 *     那个方向对它是对的；权重类模型反过来。）
 *
 * 2. **扫描无状态，每次现扫。**
 *    本地场景只有几十个文件，重扫比维护缓存便宜，且不会出现「缓存与磁盘不一致」。
 *    这也是「本地拖入文件后刷新页面就能看到」得以成立的前提。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** server/src/services → 仓库根 */
const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

/** 模型根目录。与 trainer 的 `Settings.models_dir` 同一默认值、同一环境变量 */
export const MODELS_ROOT = (
  process.env.MODELS_DIR?.trim() || path.join(REPO_ROOT, 'models')
).replace(/[\\/]$/, '');

/** 扫描深度上限：够覆盖「扁平放」与「一模型一目录」两种习惯，又不会误扫进模型内部 */
const MAX_DEPTH = 2;

// --------------------------------------------------------------------------
// 类别定义表（唯一事实源）
// --------------------------------------------------------------------------

export interface ModelCategorySpec {
  key: string;
  label: string;
  /** 相对 MODELS_ROOT 的子目录 */
  dir: string;
  /** 界面上一句话说明 */
  hint: string;
  /**
   * 主权重文件的匹配规则 —— 决定「这是一个模型」。
   * 为 null 表示该类别暂无权重概念（预留类别）。
   */
  primary: RegExp | null;
  /** 必须与主权重同目录存在的文件（缺失 → 标记 incomplete，但**不隐藏**） */
  required: string[];
  /** 与主权重同 basename 联动的文件（改名 / 删除时必须一起处理） */
  companions: RegExp[];
  /** 允许导入的扩展名 */
  allowed: string[];
  /**
   * 兼容读取的旧位置（相对 MODELS_ROOT，或绝对路径）。
   *
   * 为什么要多根：改前模型散落在好几处，且用户自己按「角色组」建过嵌套目录，
   * 直接换根会让既有模型全部「消失」。所以先并存读取，
   * 等迁移脚本（`docs/VOICE-MODEL-MANAGEMENT-PLAN.md` §9）跑完再摘掉。
   *
   * 与 trainer 的 `Settings.rvc_model_search_dirs` 必须**保持一致**，
   * 否则会出现「音色库页看得见、但选不中/加载不了」的错位。
   */
  legacy_dirs?: string[];
  /** 预留类别：目录存在但功能未接入，界面要如实说明 */
  reserved?: string;
}

/**
 * RVC 的 `trained_*` 是训练中间件（`infer-web.py` 的 save_every_weights 产物命名约定），
 * 不是可直接使用的音色模型 —— 与 `vc/models.py` 的既有判断保持一致。
 */
const RVC_PRIMARY = /^(?!trained_)[^/\\]+\.pth$/i;

export const MODEL_CATEGORIES: ModelCategorySpec[] = [
  {
    key: 'rvc',
    label: 'RVC 变声',
    dir: 'rvc',
    hint: '一个音色 = 一个 .pth 权重 + 可选的同名 .index 检索索引',
    primary: RVC_PRIMARY,
    required: [],
    companions: [/\.index$/i],
    allowed: ['.pth', '.index'],
    // 与 trainer `Settings.rvc_model_search_dirs` 对齐（见该属性的注释）。
    // 三个根必须一一对应，否则会出现「引擎能加载但界面看不见」的错位。
    legacy_dirs: [
      'RVC语音模型',                                  // 用户自己的组织方式
      path.join(REPO_ROOT, 'trainer', '.data', 'vc', 'models'), // P0 之前的旧根
    ],
  },
  {
    key: 'ddsp-svc',
    label: '歌声转换',
    dir: 'ddsp-svc',
    hint: '一个音色 = 一个 .pt 权重 + 同目录的 config.yaml（缺一不可）',
    primary: /\.pt$/i,
    required: ['config.yaml'],
    companions: [/^config\.ya?ml$/i],
    allowed: ['.pt', '.yaml', '.yml'],
    /**
     * 兼容读取的旧位置（阶段 33 / P3 补；模型本体已于收口时迁入规范根，旧根清空后保留）：
     * 引擎侧 `svc/catalog.py::model_dirs()` 一直认这两个根，而注册表只扫 `models/ddsp-svc`
     * —— 不补这两根，翻唱页一换数据源，已有的音色（如 `smoke`）就会**凭空消失**。
     * （RVC 在 P0 就吃过同一个亏，见坑 51。）
     */
    legacy_dirs: [
      path.join(REPO_ROOT, 'trainer', '.data', 'svc', 'models'),
      'checkpoints/ddsp',
    ],
  },
  {
    key: 'gpt-sovits',
    label: 'GPT-SoVITS 微调',
    dir: 'gpt-sovits',
    hint: '一个音色 = .ckpt（GPT）+ .pth（SoVITS）成对；零样本用法不需要这里的文件',
    primary: /\.ckpt$/i,
    required: [],
    companions: [/\.pth$/i],
    allowed: ['.ckpt', '.pth'],
  },
  {
    key: 'netease',
    label: '网易 Confucius4-TTS',
    dir: 'netease',
    hint: '预留目录：微调接入后自训权重会落在这里；当前仍以参考音频（零样本）方式使用',
    // 预留：上游有微调流水线（train_t2s.py / train_s2a.py），但本项目尚未接入训练。
    // 建目录是为了给将来的微调产物一个落点，不是为了现在就扫出东西。
    primary: null,
    required: [],
    companions: [],
    allowed: ['.safetensors', '.pt', '.ckpt'],
    reserved:
      '网易的微调尚未接入。上游自带训练流水线（train_t2s.py / train_s2a.py），' +
      '接入后自训权重会落在这里。目前它仍以参考音频（零样本）方式使用。',
  },
];

export function findCategory(key: string): ModelCategorySpec {
  const spec = MODEL_CATEGORIES.find((item) => item.key === key);
  if (!spec) {
    throw new ModelRegistryError(
      404,
      'MODEL_CATEGORY_UNKNOWN',
      `未知的模型类别：${key}`,
      `可用类别：${MODEL_CATEGORIES.map((item) => item.key).join('、')}`,
    );
  }
  return spec;
}

// --------------------------------------------------------------------------
// 错误
// --------------------------------------------------------------------------

export class ModelRegistryError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint?: string;
  constructor(status: number, code: string, message: string, hint?: string) {
    super(message);
    this.name = 'ModelRegistryError';
    this.status = status;
    this.code = code;
    this.hint = hint;
  }
}

// --------------------------------------------------------------------------
// 数据结构
// --------------------------------------------------------------------------

export interface ModelFile {
  /** 文件名（不含目录） */
  name: string;
  /** 相对 MODELS_ROOT 的路径，用 `/` 分隔（跨平台一致的展示形式） */
  rel: string;
  /** 绝对路径 */
  abs: string;
  bytes: number;
  /** 角色：主权重 / 配套 / 必需 */
  role: 'primary' | 'companion' | 'required';
}

/**
 * 未识别文件：在类别目录里，但不属于任何模型。
 *
 * 存在的意义是「用户拖了文件进来却看不到」——
 * 与其静默丢弃，不如列出来并说清缺什么（方案 P3 第 17 项）。
 */
export interface ModelStrayFile {
  name: string;
  rel: string;
  abs: string;
  bytes: number;
  /** 为什么不算模型 */
  reason: 'no-primary' | 'not-recognized' | 'reserved';
  /** 按类别规则生成的、可执行的修复提示 */
  hint: string;
}

export interface ModelMeta {
  display_name?: string;
  note?: string;
  tags?: string[];
  origin?: string;
  created_at?: number;
}

export interface ModelEntry {
  /** 稳定 id：由「相对目录路径」派生 —— 改名不影响它，前端选中项不会丢 */
  id: string;
  category: string;
  /** 界面显示名 */
  name: string;
  /** 若与 name 不同，这里是原始文件名/目录名，用于排障 */
  raw_name: string;
  /** 相对**所在搜索根**的目录（`/` 分隔）；根目录本身为 `.` */
  rel_dir: string;
  /** 所在搜索根的绝对路径 */
  root: string;
  /** 是否来自兼容读取的旧位置（true = 界面应提示「建议迁移到 models/<category>/」） */
  legacy: boolean;
  /**
   * 该模型独占一个目录（目录里只有一个主权重）。
   *
   * 决定两件事：
   *   * 显示名优先取**目录名**（DDSP-SVC 官方导出几乎都叫 `model.pt`）；
   *   * sidecar 元数据放目录级 `.meta.json` 还是 `<stem>.meta.json`
   *     —— 同一目录里有多个模型时，目录级的会被它们共用、互相覆盖。
   */
  single_model_dir: boolean;
  files: ModelFile[];
  bytes: number;
  updated_at: number;
  /** 缺少 required 文件时为 true（**不隐藏**，让用户看到并自行补齐） */
  incomplete: boolean;
  missing: string[];
  meta: ModelMeta;
  /** 疑似重复：与另一个模型「主权重同名同大小」。本地拖入无法在导入时拦截，只能扫出来提示 */
  duplicate_of?: string;
}

export interface ModelCategoryView {
  key: string;
  label: string;
  hint: string;
  /** 该类别规范根目录的绝对路径 —— 用户要手动放文件时得知道放哪 */
  dir: string;
  exists: boolean;
  /** 兼容读取的旧位置（已过滤为存在的目录） */
  legacy_dirs: string[];
  count: number;
  reserved?: string;
}

// --------------------------------------------------------------------------
// 工具
// --------------------------------------------------------------------------

function isDir(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 相对路径统一用 `/`，避免 Windows 的 `\` 漏到前端与 id 计算里 */
function toRel(from: string, abs: string): string {
  return path.relative(from, abs).split(path.sep).join('/');
}

function shortId(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, 12);
}

/** 一个类别要扫的根：规范位置 + 兼容的旧位置 */
interface ScanRoot {
  /** 绝对路径 */
  dir: string;
  /** 是否规范位置（`models/<category.dir>`）。false = 旧位置，界面要提示迁移 */
  canonical: boolean;
  /** 用于拼 id 的稳定前缀，避免不同根下的同名模型撞 id */
  key: string;
}

function resolveRoots(spec: ModelCategorySpec): ScanRoot[] {
  const roots: ScanRoot[] = [];
  const canonical = path.join(MODELS_ROOT, spec.dir);
  roots.push({ dir: canonical, canonical: true, key: spec.dir });

  for (const raw of spec.legacy_dirs ?? []) {
    // 绝对路径直接用；相对路径视为相对 MODELS_ROOT
    const dir = path.isAbsolute(raw) ? raw : path.join(MODELS_ROOT, raw);
    if (dir === canonical) continue;
    roots.push({ dir, canonical: false, key: toRel(MODELS_ROOT, dir) || dir });
  }
  return roots;
}

/**
 * 路径边界检查 —— 硬约束。
 *
 * 任何写操作解析后的绝对路径**必须落在该类别的某个搜索根内**，否则拒绝。
 * 这是防止「传错路径误删别处文件」的唯一屏障（`svc/catalog.py::delete_model()`
 * 已经为删除写过一遍同样的检查，这里是把它提到注册表层统一执行）。
 *
 * 注意要检查**全部**搜索根（含兼容读取的旧位置）—— 否则用户没法删掉
 * 旧位置里的垃圾模型，只能自己去资源管理器翻。
 */
export function assertInsideCategory(spec: ModelCategorySpec, abs: string): void {
  const resolved = path.resolve(abs);
  const roots = resolveRoots(spec).map((item) => path.resolve(item.dir));
  const inside = roots.some((root) => {
    const relative = path.relative(root, resolved);
    // `relative === ''` 表示 resolved **就是**根本身 —— 也算在界内。
    // 漏掉这一条会让「把扁平旧根里的模型迁走」这种合法操作被自己的安全检查拒掉
    // （实测踩过：8 个模型全部以「路径不在任何搜索目录内」失败）。
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
  });
  if (!inside) {
    throw new ModelRegistryError(
      400,
      'MODEL_PATH_OUTSIDE',
      `路径不在「${spec.label}」的任何搜索目录内，已拒绝：${resolved}`,
      `允许的根目录：${roots.join('、')}`,
    );
  }
}

// --------------------------------------------------------------------------
// sidecar 元数据
// --------------------------------------------------------------------------

const META_NAME = '.meta.json';

/**
 * 元数据文件的位置。
 *
 * 单模型目录用目录级 `.meta.json`；**多模型目录必须用 `<stem>.meta.json`** ——
 * 否则同一目录里的几个模型会共用一份元数据、互相覆盖显示名。
 */
export function metaPathFor(model: Pick<ModelEntry, 'root' | 'rel_dir' | 'raw_name' | 'single_model_dir'>): string {
  const dir = path.join(model.root, model.rel_dir === '.' ? '' : model.rel_dir);
  return model.single_model_dir
    ? path.join(dir, META_NAME)
    : path.join(dir, `${model.raw_name}${META_NAME}`);
}

function readMetaFile(target: string): ModelMeta {
  if (!isFile(target)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(target, 'utf-8')) as ModelMeta;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    // 坏 JSON 不该让整个列表挂掉：当成没有元数据
    return {};
  }
}

function writeMetaFile(target: string, meta: ModelMeta): void {
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

// --------------------------------------------------------------------------
// 扫描
// --------------------------------------------------------------------------

/** 广度受限的目录遍历（只下钻 MAX_DEPTH 层） */
function walk(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  out.push(dir);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // 跳过隐藏目录与训练产物目录，避免把引擎内部结构当成模型
    if (entry.name.startsWith('.')) continue;
    walk(path.join(dir, entry.name), depth + 1, out);
  }
}

function fileSize(abs: string): number {
  try {
    return fs.statSync(abs).size;
  } catch {
    return 0;
  }
}

function fileEntry(abs: string, role: ModelFile['role']): ModelFile {
  return {
    name: path.basename(abs),
    rel: toRel(MODELS_ROOT, abs),
    abs,
    bytes: (() => {
      try {
        return fs.statSync(abs).size;
      } catch {
        return 0;
      }
    })(),
    role,
  };
}

/**
 * 扫一个目录，产出该目录下的模型条目。
 *
 * **两种布局都要支持**（这是「不拍平」约定能落地的前提）：
 *   * 目录里只有一个主权重 → 该目录就是一个模型，`files` 收集目录内所有匹配文件
 *     （覆盖 DDSP-SVC 的 `model.pt` + `config.yaml`、GPT-SoVITS 的 `.ckpt` + `.pth`）
 *   * 目录里有多个主权重 → 每个主权重各算一个模型，`files` 只收**同 basename** 的配套
 *     （覆盖 RVC 扁平放多个 `.pth` 的习惯）
 */
function scanDir(spec: ModelCategorySpec, dir: string, root: ScanRoot): ModelEntry[] {
  if (!spec.primary) return [];

  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const filesInDir = names
    .map((name) => path.join(dir, name))
    .filter((abs) => isFile(abs));

  const primaries = filesInDir.filter((abs) => spec.primary!.test(path.basename(abs)));
  if (primaries.length === 0) return [];

  const relDir = toRel(root.dir, dir);
  const singleModelDir = primaries.length === 1;

  return primaries.map((primaryAbs) => {
    const stem = path.basename(primaryAbs, path.extname(primaryAbs));

    // 显示名优先取子目录名（DDSP-SVC 官方导出几乎都叫 model.pt，用 stem 会全变成「model」）
    const rawName = singleModelDir && relDir !== '' && relDir !== '.'
      ? path.basename(dir)
      : stem;

    // 元数据位置随布局而变：单模型目录用目录级，多模型目录必须按 stem 分开
    const metaTarget = singleModelDir
      ? path.join(dir, META_NAME)
      : path.join(dir, `${stem}${META_NAME}`);
    const meta = readMetaFile(metaTarget);

    const files: ModelFile[] = [fileEntry(primaryAbs, 'primary')];

    // 配套文件：同 basename（如 RVC 的 .index）
    for (const abs of filesInDir) {
      if (abs === primaryAbs) continue;
      const base = path.basename(abs);
      const baseStem = path.basename(abs, path.extname(abs));
      if (spec.companions.some((rule) => rule.test(base)) && baseStem === stem) {
        files.push(fileEntry(abs, 'companion'));
      }
    }

    // 必需文件：同目录存在即可（如 DDSP-SVC 的 config.yaml —— 名字与权重不同名）
    const missing: string[] = [];
    for (const needed of spec.required) {
      const abs = path.join(dir, needed);
      if (isFile(abs)) files.push(fileEntry(abs, 'required'));
      else missing.push(needed);
    }

    // 单模型目录：把目录里其余「同类别可识别」的文件也收进来，
    // 覆盖 GPT-SoVITS 的 `.ckpt`（GPT）与 `.pth`（SoVITS）**不同名但成对**的情况
    if (singleModelDir) {
      for (const abs of filesInDir) {
        if (files.some((item) => item.abs === abs)) continue;
        const ext = path.extname(abs).toLowerCase();
        if (spec.allowed.includes(ext)) files.push(fileEntry(abs, 'companion'));
      }
    }

    return {
      id: shortId(`${root.key}/${relDir}/${singleModelDir ? '' : stem}`),
      category: spec.key,
      name: meta.display_name?.trim() || rawName,
      raw_name: rawName,
      rel_dir: relDir === '' ? '.' : relDir,
      root: root.dir,
      legacy: !root.canonical,
      single_model_dir: singleModelDir,
      files,
      bytes: files.reduce((sum, item) => sum + item.bytes, 0),
      updated_at: Math.max(...files.map((item) => {
        try {
          return fs.statSync(item.abs).mtimeMs;
        } catch {
          return 0;
        }
      })),
      incomplete: missing.length > 0,
      missing,
      meta,
    } satisfies ModelEntry;
  });
}

/** 扫描一个类别下的全部模型（规范位置 + 兼容旧位置，按绝对路径去重） */
export function listModels(categoryKey: string): ModelEntry[] {
  const spec = findCategory(categoryKey);

  const seen = new Set<string>();
  const models: ModelEntry[] = [];

  for (const root of resolveRoots(spec)) {
    if (!isDir(root.dir)) continue;
    const dirs: string[] = [];
    walk(root.dir, 0, dirs);
    for (const dir of dirs) {
      for (const model of scanDir(spec, dir, root)) {
        // 同一个模型可能同时命中两个根（例如用户把新根软链到旧目录）—— 去重
        const fingerprint = model.files.map((item) => item.abs.toLowerCase()).join('|');
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        models.push(model);
      }
    }
  }

  // 重复检测：主权重「同名 + 同大小」视为疑似重复。
  // 刻意**不做全量 hash** —— 模型动辄几百 MB，算 hash 会让列表卡死；
  // 本地场景下同名同大小而内容不同的概率极低，且误判后果只是「多提示了一句」。
  const byFingerprint = new Map<string, string>();
  for (const model of models) {
    const primary = model.files.find((item) => item.role === 'primary');
    if (!primary) continue;
    const fingerprint = `${primary.name.toLowerCase()}\u0000${primary.bytes}`;
    const seenId = byFingerprint.get(fingerprint);
    if (seenId) model.duplicate_of = seenId;
    else byFingerprint.set(fingerprint, model.id);
  }

  return models.sort((a, b) => b.updated_at - a.updated_at);
}

/**
 * 「未识别文件」：在类别目录里，**不属于任何模型**的散文件。
 *
 * 为什么必须有这一路：改前散文件是被**静默丢弃**的 ——
 * `scanDir()` 看到目录里没有主权重就整个 `return []`，
 * 用户拖进去一个 `xxx.index`（没有配套的 `.pth`）或一个 `说明.txt`，
 * 界面上什么都不会出现，用户只会觉得「我明明放进去了」。
 *
 * 现在把它们单列出来并**说明缺什么**，而不是假装不存在。
 */
export function listStrays(categoryKey: string): ModelStrayFile[] {
  const spec = findCategory(categoryKey);

  // 已被模型认领的文件（含 sidecar 元数据）不算散文件
  const models = listModels(categoryKey);
  const owned = new Set<string>();
  for (const model of models) {
    for (const file of model.files) owned.add(file.abs.toLowerCase());
    owned.add(metaPathFor(model).toLowerCase());
  }

  // 给用户的「为什么不算模型」说明，按类别的实际规则生成，不写死
  const recognized = spec.allowed.length > 0 ? spec.allowed.join(' / ') : '（该类别尚未定义可识别类型）';
  const hintFor = (reason: ModelStrayFile['reason']): string =>
    reason === 'no-primary'
      ? `这个目录里没有主权重，所以整目录都没被识别 —— ${spec.label} 靠主权重认模型（可识别类型：${recognized}）`
      : reason === 'reserved'
        ? `${spec.label} 的加载代码还没接入，目录里的文件暂时无法使用`
        : `不属于 ${spec.label} 的文件类型（可识别：${recognized}），或与主权重不同名 —— 改名/补齐后刷新即可`;

  const strays: ModelStrayFile[] = [];
  const seen = new Set<string>();

  for (const root of resolveRoots(spec)) {
    if (!isDir(root.dir)) continue;
    const dirs: string[] = [];
    walk(root.dir, 0, dirs);

    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      const filesInDir = names.map((name) => path.join(dir, name)).filter((abs) => isFile(abs));
      // 预留类别（primary 为 null）永远认不出模型；否则看目录里有没有主权重
      const reason: ModelStrayFile['reason'] = !spec.primary
        ? 'reserved'
        : filesInDir.some((abs) => spec.primary!.test(path.basename(abs)))
          ? 'not-recognized'
          : 'no-primary';

      for (const abs of filesInDir) {
        const key = abs.toLowerCase();
        if (owned.has(key) || seen.has(key)) continue;
        const base = path.basename(abs);
        // 隐藏文件与我们自己的 sidecar 不算「用户放错的东西」
        if (base.startsWith('.') || base.endsWith(META_NAME)) continue;
        seen.add(key);
        strays.push({
          name: base,
          rel: toRel(MODELS_ROOT, abs),
          abs,
          bytes: fileSize(abs),
          reason,
          hint: hintFor(reason),
        });
      }
    }
  }

  return strays.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 类别总览：给音色库页的 Tab 与「打开目录」用 */
export function listCategories(): ModelCategoryView[] {
  return MODEL_CATEGORIES.map((spec) => {
    const dir = path.join(MODELS_ROOT, spec.dir);
    const exists = isDir(dir);
    const legacyDirs = (spec.legacy_dirs ?? []).map((raw) =>
      path.isAbsolute(raw) ? raw : path.join(MODELS_ROOT, raw),
    );
    return {
      key: spec.key,
      label: spec.label,
      hint: spec.hint,
      dir,
      exists,
      legacy_dirs: legacyDirs.filter((item) => isDir(item)),
      count: spec.primary ? listModels(spec.key).length : 0,
      reserved: spec.reserved,
    };
  });
}

/** 按 id 取一个模型（id 不含类别前缀，所以要遍历） */
export function findModel(id: string): { spec: ModelCategorySpec; model: ModelEntry } {
  for (const spec of MODEL_CATEGORIES) {
    const hit = listModels(spec.key).find((item) => item.id === id);
    if (hit) return { spec, model: hit };
  }
  throw new ModelRegistryError(
    404,
    'MODEL_NOT_FOUND',
    `模型不存在：${id}`,
    '它可能已被移动或删除，请刷新列表。',
  );
}

// --------------------------------------------------------------------------
// 写操作
// --------------------------------------------------------------------------

/**
 * 删除一个模型：连同它的全部配套文件一起删。
 *
 * 只删 `.pth` 会把 `.index` 留成孤儿（RVC 官方约定：索引失配不报错，
 * 只是静默用不上、听感悄悄变差 —— `vc/models.py` 已记录这个坑）。
 */
export function deleteModel(id: string): { removed: string[] } {
  const { spec, model } = findModel(id);
  const removed: string[] = [];
  for (const file of model.files) {
    assertInsideCategory(spec, file.abs);
    try {
      fs.unlinkSync(file.abs);
      removed.push(file.rel);
    } catch {
      // 单个文件删不掉不阻断其余（可能被占用）
    }
  }
  // sidecar 一并清掉，避免留下指向已删模型的元数据
  const metaPath = path.join(MODELS_ROOT, model.rel_dir, META_NAME);
  if (isFile(metaPath)) {
    try {
      fs.unlinkSync(metaPath);
    } catch {
      // 同上
    }
  }
  return { removed };
}

/** 确保类别目录存在（首次访问时按需创建，不预建一堆空目录） */
export function ensureCategoryDir(spec: ModelCategorySpec): string {
  const dir = path.join(MODELS_ROOT, spec.dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// --------------------------------------------------------------------------
// 导入
// --------------------------------------------------------------------------

export type ConflictPolicy = 'reject' | 'overwrite' | 'keep_both';

export interface ImportOptions {
  /** 相对类别根的子目录（保留用户的文件夹结构，**不拍平**） */
  subdir?: string;
  /** 原始文件名 */
  filename: string;
  /** 已落盘的临时文件（由路由层流式写入，避免把几百 MB 读进内存） */
  tempPath: string;
  onConflict?: ConflictPolicy;
}

export interface ImportConflict {
  /** 已存在的模型（同名同大小） */
  existing: { id: string; name: string; rel: string; bytes: number };
  /** 本次要导入的 */
  incoming: { name: string; rel: string; bytes: number };
}

export interface ImportResult {
  ok: true;
  /** 最终落盘的相对路径 */
  rel: string;
  abs: string;
  bytes: number;
  /** 冲突策略生效时说明改成了什么 */
  renamed_to?: string;
  /** 缺必需配套文件时的提醒（导入成功但会标 incomplete） */
  warnings: string[];
}

function safeSubdir(spec: ModelCategorySpec, raw: string | undefined): string {
  const trimmed = (raw ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  // 逐段过滤，杜绝 `..` 穿越与绝对路径
  const parts = trimmed
    .split('/')
    .map((part) => part.trim())
    .filter((part) => part && part !== '.' && part !== '..' && !part.includes(':'));
  const joined = parts.join('/');
  // 最后再确认一次落在类别根内（双保险）
  assertInsideCategory(spec, path.join(MODELS_ROOT, spec.dir, joined, 'x'));
  return joined;
}

/**
 * 把一个已落盘的文件导入到类别目录。
 *
 * **重复判定用「同名 + 同大小」**，刻意不做全量 hash：
 * 模型动辄几百 MB，算 hash 会让导入卡死；本地场景下同名同大小而内容不同的概率极低，
 * 且误判的后果只是「多提示了一次」。
 */
export function importModel(spec: ModelCategorySpec, opts: ImportOptions): ImportResult {
  const filename = path.basename(opts.filename || '');
  if (!filename) {
    throw new ModelRegistryError(400, 'MODEL_FILENAME_REQUIRED', '缺少文件名');
  }
  const ext = path.extname(filename).toLowerCase();
  if (spec.allowed.length > 0 && !spec.allowed.includes(ext)) {
    throw new ModelRegistryError(
      400,
      'MODEL_FORMAT_UNSUPPORTED',
      `「${spec.label}」不接受 ${ext || '无扩展名'} 文件`,
      `可用格式：${spec.allowed.join('、')}`,
    );
  }

  const subdir = safeSubdir(spec, opts.subdir);
  const targetDir = path.join(MODELS_ROOT, spec.dir, subdir);
  assertInsideCategory(spec, path.join(targetDir, filename));
  fs.mkdirSync(targetDir, { recursive: true });

  const bytes = (() => {
    try {
      return fs.statSync(opts.tempPath).size;
    } catch {
      return 0;
    }
  })();

  let targetName = filename;
  const existing = path.join(targetDir, targetName);
  if (isFile(existing)) {
    const existingBytes = (() => {
      try {
        return fs.statSync(existing).size;
      } catch {
        return -1;
      }
    })();
    const policy = opts.onConflict ?? 'reject';

    if (existingBytes === bytes && policy === 'reject') {
      const rel = toRel(MODELS_ROOT, existing);
      const conflict: ImportConflict = {
        existing: { id: '', name: path.basename(filename, ext), rel, bytes: existingBytes },
        incoming: { name: filename, rel, bytes },
      };
      throw new ModelImportConflict(conflict);
    }

    if (policy === 'keep_both') {
      const stem = path.basename(filename, ext);
      let n = 1;
      while (isFile(path.join(targetDir, `${stem}-${n}${ext}`))) n += 1;
      targetName = `${stem}-${n}${ext}`;
    }
    // overwrite：直接用原名覆盖（下面 rename 会替换）
  }

  const target = path.join(targetDir, targetName);
  assertInsideCategory(spec, target);
  // 同盘 rename 是原子的；跨盘会失败，退化为「复制 + 删源」
  try {
    fs.renameSync(opts.tempPath, target);
  } catch {
    fs.copyFileSync(opts.tempPath, target);
    try {
      fs.unlinkSync(opts.tempPath);
    } catch {
      // 删不掉临时文件不影响导入结果
    }
  }

  const warnings: string[] = [];
  for (const needed of spec.required) {
    if (!isFile(path.join(targetDir, needed))) {
      warnings.push(`同目录缺少 ${needed}，该模型会被标记为「不完整」`);
    }
  }

  return {
    ok: true,
    rel: toRel(MODELS_ROOT, target),
    abs: target,
    bytes,
    renamed_to: targetName !== filename ? targetName : undefined,
    warnings,
  };
}

/** 导入冲突（同名同大小）—— 用独立错误类型，路由层据此返回 409 + 结构化信息 */
export class ModelImportConflict extends ModelRegistryError {
  readonly conflict: ImportConflict;
  constructor(conflict: ImportConflict) {
    super(
      409,
      'MODEL_DUPLICATE',
      `「${conflict.existing.rel}」已存在且大小相同（${conflict.existing.bytes} 字节）`,
      '选「跳过」保留现有文件，或选「保留两份」自动加 -1 后缀。',
    );
    this.name = 'ModelImportConflict';
    this.conflict = conflict;
  }
}

// --------------------------------------------------------------------------
// 重命名 / 元数据
// --------------------------------------------------------------------------

/** 去掉文件名里的非法字符（Windows 下 `\/:*?"<>|` 都不能用） */
function sanitizeName(raw: string, fallback: string): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/, '')
    .slice(0, 120);
  return cleaned || fallback;
}

/**
 * 重命名一个模型（**联动配套文件**）。
 *
 * 只改主权重会让配套文件当场失配：RVC 的 `.index` 靠文件名配对
 * （`vc/models.py::index_path_for` 已记录这个坑），DDSP-SVC 的 `config.yaml`
 * 虽不同名但必须同目录 —— 改名后仍同目录，所以只需处理同名配套。
 */
export function renameModel(id: string, newName: string): { renamed: string[]; new_id: string; name: string } {
  const { spec, model } = findModel(id);
  const primary = model.files.find((item) => item.role === 'primary');
  if (!primary) {
    throw new ModelRegistryError(400, 'MODEL_NO_PRIMARY', '该条目没有主权重文件，无法重命名');
  }

  const ext = path.extname(primary.name);
  const clean = sanitizeName(newName, model.raw_name);
  if (clean === model.raw_name) {
    return { renamed: [], new_id: model.id, name: clean };
  }

  const renamed: string[] = [];
  const dir = path.dirname(primary.abs);

  // 先检查目标是否已被占用，避免改到一半失败留下半套文件
  for (const file of model.files) {
    const fileExt = path.extname(file.name);
    const targetName =
      file.role === 'required'
        ? file.name // 必需文件（config.yaml）名字固定，不跟着改
        : `${clean}${fileExt}`;
    const target = path.join(dir, targetName);
    assertInsideCategory(spec, target);
    if (target !== file.abs && isFile(target)) {
      throw new ModelRegistryError(
        409,
        'MODEL_NAME_TAKEN',
        `目标名称已被占用：${targetName}`,
        '换一个名字，或先处理掉同名的那个文件。',
      );
    }
  }

  for (const file of model.files) {
    if (file.role === 'required') continue;
    const fileExt = path.extname(file.name);
    const target = path.join(dir, `${clean}${fileExt}`);
    if (target === file.abs) continue;
    fs.renameSync(file.abs, target);
    renamed.push(toRel(MODELS_ROOT, target));
  }

  // 元数据跟着走：多模型目录下它按 stem 命名，改名后要一起改
  if (!model.single_model_dir) {
    const oldMeta = metaPathFor(model);
    if (isFile(oldMeta)) {
      const newMeta = path.join(dir, `${clean}${META_NAME}`);
      try {
        fs.renameSync(oldMeta, newMeta);
      } catch {
        // 元数据没跟上不影响模型可用性
      }
    }
  }

  const newId = shortId(
    `${toRel(MODELS_ROOT, model.root)}/${model.rel_dir}/${model.single_model_dir ? '' : clean}`,
  );
  return { renamed, new_id: newId, name: clean };
}

export interface UpdateMetaPatch {
  display_name?: string;
  note?: string;
  tags?: string[];
}

/** 写 sidecar 元数据（显示名 / 备注 / 标签）。空字符串表示清除该项。 */
export function updateModelMeta(id: string, patch: UpdateMetaPatch): ModelMeta {
  const { spec, model } = findModel(id);
  const target = metaPathFor(model);
  assertInsideCategory(spec, target);

  const meta = readMetaFile(target);
  if (patch.display_name !== undefined) {
    const value = patch.display_name.trim();
    if (value) meta.display_name = value;
    else delete meta.display_name;
  }
  if (patch.note !== undefined) {
    const value = patch.note.trim();
    if (value) meta.note = value;
    else delete meta.note;
  }
  if (patch.tags !== undefined) {
    const value = patch.tags.map((tag) => tag.trim()).filter(Boolean);
    if (value.length) meta.tags = value;
    else delete meta.tags;
  }

  if (Object.keys(meta).length === 0) {
    // 全空就把文件删掉，不留垃圾
    try {
      fs.unlinkSync(target);
    } catch {
      // 本来就不存在
    }
  } else {
    meta.origin = meta.origin ?? 'imported';
    meta.created_at = meta.created_at ?? Math.floor(Date.now() / 1000);
    writeMetaFile(target, meta);
  }
  return meta;
}

// --------------------------------------------------------------------------
// 迁移（把旧位置的模型收口到规范根）
// --------------------------------------------------------------------------

export interface MigrationItem {
  /** 源目录（绝对路径） */
  from: string;
  /** 目标目录（绝对路径） */
  to: string;
  name: string;
  bytes: number;
  /** 目标已存在同名文件 → 跳过，不覆盖 */
  conflict: boolean;
  /**
   * 要移动的**具体文件**（绝对路径）。
   *
   * 必须按文件搬，不能按目录搬 —— 扁平布局下多个模型共用一个目录，
   * 按目录搬会把同目录里别的模型一起卷走（实测踩过）。
   */
  files: string[];
}

/**
 * 计算迁移计划（**只读，不改任何文件**）。
 *
 * 把「兼容读取的旧位置」里的模型搬到规范根（`models/<category>/`），
 * **保留原有的相对目录结构**（不拍平 —— 拍平正是当前混乱的来源）。
 */
export function planMigration(categoryKey: string): { items: MigrationItem[]; legacy_roots: string[] } {
  const spec = findCategory(categoryKey);
  const canonicalRoot = path.join(MODELS_ROOT, spec.dir);
  const legacyRoots = resolveRoots(spec).filter((root) => !root.canonical).map((root) => root.dir);

  const items: MigrationItem[] = [];
  for (const model of listModels(categoryKey)) {
    if (!model.legacy) continue;

    const srcDir = path.join(model.root, model.rel_dir === '.' ? '' : model.rel_dir);
    // 目标 = 规范根 + 同一个相对目录（保留结构）
    const dstDir = path.join(canonicalRoot, model.rel_dir === '.' ? '' : model.rel_dir);

    const primary = model.files.find((item) => item.role === 'primary');
    if (!primary) continue;

    // 只搬这个模型自己的文件 + 它的 sidecar
    const moveList = model.files.map((file) => file.abs);
    const sidecar = metaPathFor(model);
    if (isFile(sidecar)) moveList.push(sidecar);

    items.push({
      from: srcDir,
      to: dstDir,
      name: model.name,
      bytes: model.bytes,
      conflict: moveList.some((abs) => isFile(path.join(dstDir, path.basename(abs)))),
      files: moveList,
    });
  }
  return { items, legacy_roots: legacyRoots };
}

/** 执行迁移。返回逐项结果；**目标已存在的一律跳过，绝不覆盖**。 */
export function runMigration(categoryKey: string): {
  moved: { name: string; from: string; to: string; files: number }[];
  skipped: { name: string; reason: string }[];
  failed: { name: string; reason: string }[];
} {
  const spec = findCategory(categoryKey);
  const { items } = planMigration(categoryKey);
  const moved: { name: string; from: string; to: string; files: number }[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const failed: { name: string; reason: string }[] = [];

  for (const item of items) {
    if (item.conflict) {
      skipped.push({ name: item.name, reason: '目标位置已有同名文件，未覆盖' });
      continue;
    }
    try {
      assertInsideCategory(spec, item.from);
      assertInsideCategory(spec, item.to);
      fs.mkdirSync(item.to, { recursive: true });

      let count = 0;
      for (const src of item.files) {
        if (!isFile(src)) continue;
        const dst = path.join(item.to, path.basename(src));
        if (isFile(dst)) continue; // 逐个文件也不覆盖
        try {
          // 同盘 rename 是原子的
          fs.renameSync(src, dst);
        } catch {
          // 跨盘退化为复制 + 删源
          fs.copyFileSync(src, dst);
          fs.unlinkSync(src);
        }
        count += 1;
      }
      moved.push({ name: item.name, from: item.from, to: item.to, files: count });
    } catch (error) {
      failed.push({ name: item.name, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { moved, skipped, failed };
}


/** 汇总：给 `/health` 与设置页展示 */
export function modelsSummary() {
  const categories = listCategories();
  return {
    root: MODELS_ROOT,
    total: categories.reduce((sum, item) => sum + item.count, 0),
    categories: categories.map((item) => ({ key: item.key, count: item.count })),
  };
}
