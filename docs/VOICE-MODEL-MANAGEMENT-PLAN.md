# 音色模型统一管理 + 产出记录页 实施方案

> 目标：把「模型散落各处、导入无序、各页各自为政」收敛成**一套目录约定 + 一个注册表 + 一个管理页**；
> 并把只记 MiMo 的「历史记录」升级为汇总所有引擎产物的「产出记录」。
>
> 本方案基于对当前代码的实际核查（含证据路径），不是纸面设计。

---

## 一、现状核查（问题清单 + 证据）

### 1.1 模型散落在 5 个位置，命名与嵌套规则互不一致

| 位置 | 内容 | 嵌套 | 谁在扫 |
| --- | --- | --- | --- |
| `trainer/.data/vc/models/` | RVC `.pth` + `.index` | **扁平** | `trainer/app/vc/models.py` |
| `trainer/.data/svc/models/` | DDSP-SVC `.pt` + `config.yaml` | **一模型一子目录** | `trainer/app/svc/catalog.py` |
| `models/checkpoints/` | GPT-SoVITS 训练产物 | 按版本/类型 | `trainer/app/weights.py` |
| `models/RVC语音模型/` | 用户自己放的 RVC 模型 | **按角色组嵌套** | **无人扫描** ← 关键问题 |
| `voicelib/` | 零样本参考音频 | 扁平 | 网关 `voiceLibrary.ts` + `sovits/voices.py` |

**实测证据**：

```
trainer/.data/vc/models/          → aiyi.pth, lenai.index, lenai.pth, lixi.pth, smoke_0.pth
trainer/.data/svc/models/         → smoke/  （一模型一目录）
models/RVC语音模型/MYGO全员/乐奈/  → lenai.index, lenai.pth
models/RVC语音模型/Mujica全员/     → ...
```

`models/RVC语音模型/` 下那批（MYGO / Mujica 全员）**从未出现在 WebUI 里** ——
因为 RVC 模型库只扫 `settings.vc_dir / "models"`（即 `trainer/.data/vc/models/`，见
`trainer/app/vc/bootstrap.py::models_dir()`），且只做**一层** `glob("*.pth")`。
用户手工把几个 `.pth` 复制到了 `.data/vc/models/` 才勉强可见，但 `.index` 配对靠「路径含模型名」的启发式
（`vc/models.py::find_index_for()`），嵌套目录下必然失配。

### 1.2 四套互不相通的「模型列表」实现

| 引擎 | 列表端点 | 导入 | 重命名 | 删除 |
| --- | --- | --- | --- | --- |
| RVC | `GET /v1/vc/catalog` | `POST /v1/vc/models/upload` | `POST /v1/vc/models/rename` | `DELETE /v1/vc/models` |
| DDSP-SVC | `GET /v1/svc/catalog` | `POST /v1/svc/models/upload` | **无** | `DELETE /v1/svc/models` |
| GPT-SoVITS | `GET /v1/weights` | 无（靠训练产出） | 无 | 无 |
| 参考音频 | `GET /api/voicelib` | `POST /api/voicelib` | `PATCH /api/voicelib/:id` | `DELETE /api/voicelib/:id` |

**四套形状、四套错误码、四种命名规则**。只有参考音频那一套是「网关原生、跨引擎共享」的
（`server/src/services/voiceLibrary.ts` 的注释已写明这个设计意图），其余三套各在 Python 侧自建。

### 1.3 配套文件联动只做对了一半

- RVC：`.pth` ↔ `.index` 的联动改名**已实现**（`vc/models.py::rename_model()`，
  注释明确写了「只改 `.pth` 会让索引当场失配（不报错，只是静默用不上，听感悄悄变差）」）。
- DDSP-SVC：`.pt` ↔ **同目录 `config.yaml`** 是硬绑定（缺了加载不了，坑 34），
  但 **`/v1/svc/models` 根本没有 rename 端点**，删也是按 id 删（阶段 27补4 才补的边界检查）。

### 1.4 历史记录只记 MiMo —— 因为它是客户端库，而本地引擎的产物在服务端

- `HistoryPage` 的数据来自 `useHistory()` → **浏览器 IndexedDB**（`app/src/lib/storage.ts`）。
- `HistoryRecord.mode` 的类型是 `TtsMode = 'preset' | 'design' | 'clone'`
  （`app/src/types/index.ts:27`）—— 这三个恰好就是 MiMo 云端的三种模式。
- 所有本地引擎（RVC / DDSP-SVC / GPT-SoVITS / UVR5 / ASR）的产物**从来不走这条链路**：
  它们落在**服务端** `trainer/.data/jobs/<id>.json`，通过 `GET /v1/jobs` 读取。

**结论：不是"没记录"，而是"记录在另一个地方，且没有页面去读它"。**
`GET /v1/jobs` 本身就支持不带 `kind` 返回全部类型（`trainer/app/api.py:982`，`limit` 上限 200），
所以汇总页的数据源**已经现成**。

### 1.5 已存在的可复用资产（不要重写）

| 资产 | 位置 | 复用点 |
| --- | --- | --- |
| 参考音频完整 CRUD + 迁移 | `server/src/services/voiceLibrary.ts`（429 行） | 统一模型服务的**模板** |
| 批量导入 / 批量导出 / 批量删除 / 智能转写 | `app/src/pages/VoiceLibraryPage.tsx`（1206 行） | 音色库页的**基础** |
| 产物路径解析（含 `artifacts.artifacts` 嵌套坑） | `app/src/hooks/useVcRunHistory.ts::collectTracks()` | 产出记录页的**核心函数**，应提为公用 |
| 任务持久化 + 全类型查询 | `trainer/.data/jobs/*.json`、`GET /v1/jobs` | 产出记录的**服务端数据源** |
| 配套文件联动改名 | `trainer/app/vc/models.py::rename_model()` | 统一 rename 的**参考实现** |

---

## 二、设计原则

1. **文件系统是事实源，清单只做覆盖层。**
   用户把文件拖进文件夹就该被识别（需求 1 的原文诉求）。元数据（显示名/标签/备注）存 sidecar
   `.meta.json`，而不是把文件清单也塞进 JSON —— 否则「文件删了清单还在」的脏数据无法避免。
   > 这与现有 `voicelib/voices.json` 的方向相反（那是索引优先）。参考音频可以继续维持现状，
   > 但**权重类模型**必须文件系统优先，因为用户的主要操作就是「拖文件进来」。

2. **目录结构必须匹配引擎的真实模型形态，不造空壳。**
   用户提的 `index` / `网易` 两个类别要特别说明：**它们是零样本引擎，没有专属权重文件**，
   音色就是一段参考音频。若照字面建两个永远空的文件夹，只会让"混乱"变成"混乱 + 疑惑"。
   → 见 §3.2 的处理方式。

3. **一套 API、一个页面。** 不为每个引擎再写一遍列表/导入/改名/删除。

4. **配套文件必须联动。** 改名/删除时把「一个音色的所有文件」当原子单位处理。

---

## 三、目录结构设计

### 3.0 实施进度

| 阶段 | 状态 |
| --- | --- |
| P0 看得见 | ✅ 完成（2026-10-09） |
| P1 管得住 | ✅ 完成（2026-10-09） |
| P2 产出记录页 | 待开工（下一步） |
| P3 体验收尾 | 待开工 |
| P4 网易微调接入 | 待立项 |
| P5 DDSP-SVC 训练入口 | 待立项 |


### 3.1 统一根目录 `models/`

```
models/                          ← 唯一的模型根（已有，现在几乎空置）
├── rvc/                         # RVC 变声：<音色名>.pth + <音色名>.index
│   └── 乐奈/                     #   可选：允许一音色一子目录（兼容现有嵌套习惯）
│       ├── lenai.pth
│       └── lenai.index
├── ddsp-svc/                    # DDSP-SVC：<音色名>/model.pt + config.yaml
│   └── smoke/
│       ├── model.pt
│       └── config.yaml
├── gpt-sovits/                  # GPT-SoVITS 训练产物：<音色名>/<音色名>.ckpt + .pth
│   └── <音色名>/
├── reference/                   # 零样本参考音频（原 voicelib/，见 §3.3）
├── pretrained/                  # 引擎自带底模，用户不用管（保持现状）
└── checkpoints/                 # 兼容期保留，见 §9 迁移
```

**关键规则**：

- **扫描要递归到固定深度**（≤2 层），但**「一个模型」的判定以「找到主权重文件」为准**，
  而不是以目录层级为准。这样扁平放和建子目录放都能识别。
  - RVC 主权重：`*.pth`（排除 `trained_*`、`*_g.pth`、`*_d.pth` 等训练中间件）
  - DDSP-SVC 主权重：`*.pt`（**必须**同目录有 `config.yaml`，否则标为「不完整」而不是隐藏）
  - GPT-SoVITS：`*.ckpt` + `*.pth` 成对
- **配套文件靠「同目录 + 同 basename」配对**，不再用「路径含模型名」的启发式
  （现有 `find_index_for()` 的写法在嵌套目录下会误配）。

### 3.2 关于 `index` 与 `网易` 两个类别

需求里提到「分别设置 rvc、svc、gptsovits、index、网易等类别文件夹」。
**核查上游代码后，这两类的结论不一样**（详见 §4.4 能力矩阵）：

| 类别 | 音色载体 | 上游有训练代码？ | 是否建目录 |
| --- | --- | --- | --- |
| RVC | `.pth` + `.index` 权重 | ✅ | ✅ `models/rvc/` |
| DDSP-SVC | `.pt` + `config.yaml` 权重 | ✅ | ✅ `models/ddsp-svc/` |
| GPT-SoVITS | 参考音频 **或** 微调权重 | ✅ `s1_train.py` / `s2_train.py` | ✅ `models/gpt-sovits/` |
| **网易 Confucius4-TTS** | 参考音频 **或** 微调权重 | ✅ **`train_t2s.py` / `train_s2a.py`** | ✅ **`models/netease/`（预留，见下）** |
| IndexTTS | **仅参考音频** | ❌ 上游无训练代码 | ❌ 不建 |

**网易 —— 推翻本方案初稿的判断。**
初稿认为「零样本引擎没有权重文件」。核查 `netease/models-src/Confucius4-TTS/` 后发现
上游**自带完整微调流水线**：

```
confuciustts/cli/train_t2s.py        # T2S（文本→语义）训练
confuciustts/cli/train_s2a.py        # S2A（语义→声学）训练
confuciustts/cli/t2s_lightning.py    # PyTorch Lightning 模块
confuciustts/dataset/t2s_dataset.py  # TSV 数据集
config/train_t2s.yaml                # 训练配置
```

`config/train_t2s.yaml` 的关键项：从 `checkpoints/t2s_model.safetensors` 起训、
数据 `data/train.tsv` + `data/val.tsv`（16 kHz）、fp16-mixed、
batch_size 2、100 epochs、AdamW lr 2e-4、cosine + 2000 步 warmup、每 2000 步存点。
**所以 `models/netease/` 不是空壳，是「待接入的微调产物目录」。**

但**接入成本不低**，三处要动：
1. 数据准备：TSV + 音频 → 需新写一个「从 jobs 产物生成训练集」的步骤；
2. 推理侧加载：上游 `confuciustts/cli/inference.py` 里 T2S/S2A 权重走
   **硬编码的 `hf_hub_download(repo_id, filename)`**（本项目 `netease/app/tts_engine.py`
   的文件头注释已经记录过这一点），要改成「可配置的本地路径」才能加载自训权重；
3. 显存：推理侧实测常驻 5.4 GB（`tts_required_vram_mb=5120`），
   训练侧的开销**必须实测**，8 GB 卡上大概率要 gradient checkpointing + 更小 batch。

**IndexTTS —— 维持「不建目录」。**
上游 README 首句即自述
「An Industrial-Level Controllable and Efficient **Zero-Shot** Text-to-Speech System」，
仓库内 `tools/` 只有 `gpu_check.py` 与 `i18n`，**无任何训练脚本**
（仅有的两处 `pytorch_lightning` 命中是 vendored 的 vocos / maskgct 组件，不是 IndexTTS 自身）。
它的权重加载是 `from_pretrained(self.model_dir)` + `load_checkpoint(codec.pth)` ——
模型是标准 PyTorch，理论上「自己写训练」可行，但那是**自研**而非「接入官方能力」，
成本与前者不在一个量级。因此不建空目录。

**处理方式（两类分别对待）**：

- `models/netease/`：**建目录**，但 UI 里标注为「预留 · 尚未接入训练」，
  并附一句「上游有官方微调流水线，可后续接入」。
- IndexTTS：不建目录。在音色库页用「按引擎看可用音色」的视图表达
  「IndexTTS 是纯零样本引擎 —— 音色来自参考音频，不需要模型文件」。


### 3.3 参考音频目录

`voicelib/` 保持不动（已有完整实现 + 一次性迁移逻辑，见 `voiceLibrary.ts`），
在 `models/` 下放一个**只读软链/说明**：

```
models/reference/  →  指向 voicelib/（或放一个 README 说明实际位置）
```

**不建议真搬家**：`voicelib/` 的路径被 `trainer/app/config.py::voices_lib_dir`、
网关 `VOICE_LIB_DIR`、`VOICES_LIB_DIR` 环境变量三处引用，搬动收益低、回归风险高。
在音色库页把它的**绝对路径显示出来**（现有 `voiceLibSummary()` 已经返回 `dir`），
用户想手动放文件时知道该放哪。

### 3.4 两种导入方式（并列，互不冲突）

**核心约定：文件系统是唯一落点。** 两条路径最终都写进 `models/<category>/`，
不存在「网页导入的模型在另一个地方」这种情况 —— 这是需求里明确要求的。

| | 方式 A：本地文件夹导入 | 方式 B：网页导入 |
| --- | --- | --- |
| 操作 | 用户用资源管理器把文件拖进 `models/rvc/` | 在音色库页拖拽/选择文件上传 |
| 落地位置 | 原地（用户放哪就是哪） | `models/<category>/`（服务端写入） |
| 生效时机 | **刷新页面 / 点「重新扫描」** | 导入完成即生效（自动 refresh） |
| 元数据 | 无（靠 sidecar 或后续补） | 可同时填显示名 / 备注 / 标签 |
| 是否需要服务 | 不需要 | 需要网关在跑 |

**两者不冲突，因为都走同一个注册表**：

- 方式 A 是「注册表的扫描自然发现」——`GET /api/models` 每次都**实时扫盘**
  （与 `voiceLibrary.ts` 的「每次操作前重读磁盘」同一哲学：
  本地场景只有几十个文件，重扫比维护缓存便宜且不会脏）。
- 方式 B 是「扫描 + 写入」——先写文件，再走同一次扫描返回。
  所以网页导入之后，用户去资源管理器看，文件**确实在那个文件夹里**。

**重复导入必须提醒**（需求原文）。判重规则：

```
同一 category 内，按 (主权重文件名 + 文件大小) 计算指纹
  ├─ 完全一致      → 拒绝，提示「已存在同名同大小的模型：<显示名>（<路径>）」
  ├─ 同名但大小不同 → 提示冲突，让用户选「覆盖 / 保留两份（自动加 -1 后缀）/ 取消」
  └─ 不同名         → 正常导入
```

要点：

- **不要用文件 hash 判重**：模型动辄几百 MB，全量 hash 会让导入卡住。
  `(文件名, 大小)` 在本地场景已经足够 —— 误判（同名同大小但内容不同）的概率极低，
  且后果只是「提示了一下但其实是新文件」，用户可手动改名重导。
- **方式 A 的重复无法在导入时拦截**（用户是直接拖进文件夹的），
  所以扫描时也要做**只读的重复检测**，在音色库页用徽标标出
  「疑似重复：与 `<另一个模型>` 同名同大小」，由用户决定删哪个。
- **配套文件一起判**：RVC 的 `.pth` + `.index` 作为一个单位比对，避免出现
  「`.pth` 重复了但 `.index` 是新的」这种半覆盖状态。

**「重新扫描」按钮**：方式 A 之后用户不必刷新整个页面，
音色库页提供一个显式的「重新扫描」按钮（调 `GET /api/models?refresh=1`）。
同时保留「刷新页面也会重扫」的行为（因为扫描本来就是无状态的）。

**文件夹导入要保留相对结构**（需求隐含）：

用户拖一个含子目录的文件夹进来时（例如把 `MYGO全员/乐奈/` 整块拖入），
按原相对路径重建 → `models/rvc/MYGO全员/乐奈/`，**而不是拍平**。
拍平正是当前混乱的来源之一（§1.1）。


---

## 四、统一模型注册表（网关侧）

新增 `server/src/services/modelRegistry.ts`，与 `voiceLibrary.ts` 同级、同风格。

### 4.1 类别定义表（唯一事实源）

```ts
export interface ModelCategorySpec {
  key: string;              // 'rvc' | 'ddsp-svc' | 'gpt-sovits'
  label: string;            // 界面名
  dir: string;              // 相对 models/ 的子目录
  /** 主权重文件的匹配规则（决定「这是一个模型」） */
  primary: RegExp;
  /** 必须同目录存在的配套文件（缺失 → 标记 incomplete，不隐藏） */
  required?: string[];
  /** 同 basename 联动改名的文件 */
  companions?: RegExp[];
  /** 允许的扩展名（导入时校验） */
  allowed: string[];
  /** 一个模型可能占多个文件时的展示顺序 */
  order?: string[];
}
```

建议初值：

| key | dir | primary | required | companions |
| --- | --- | --- | --- | --- |
| `rvc` | `rvc/` | `/^(?!trained_).+\.pth$/i` | — | `.index` |
| `ddsp-svc` | `ddsp-svc/` | `/\.pt$/i` | `config.yaml` | `config.yaml` |
| `gpt-sovits` | `gpt-sovits/` | `/\.ckpt$/i` | — | `.pth` |

> RVC 的 `trained_*` 排除规则来自官方约定（`vc/models.py` 里已有同样判断）。

### 4.2 扫描算法

```
scan(category):
  for dir in walk(root/<category.dir>, maxDepth=2):
    for f in dir where category.primary matches f:
      model = {
        id: hash(relpath(dir, root)),      // 稳定 id：目录相对路径，改名不影响配对
        name: 优先 sidecar.display_name → dir.name（若是子目录）→ f.stem,
        files: [f] + 同目录里匹配 companions 的文件,
        size_bytes: sum(files.size),
        mtime: max(files.mtime),
        incomplete: required 有缺失,
        missing: [...],
      }
```

**要点**：

- `id` 用**目录相对路径的 hash**，不用文件名 —— 这样重命名时 id 不变，前端选中项不丢。
- `name` 优先取**子目录名**（因为 DDSP-SVC 官方导出几乎都叫 `model.pt`，
  这个坑在阶段 27补4 已经踩过：`describe_model()` 原来用 `path.stem` 导致下拉框里全是「model」）。
- 递归深度 ≤2：够覆盖「扁平」和「一模型一目录」两种习惯，又不会误扫到模型内部的资源目录。

### 4.3 sidecar 元数据（可选覆盖层）

`models/<category>/<name>/.meta.json`（扁平布局则 `<name>.meta.json`）：

```json
{
  "display_name": "乐奈（MYGO）",
  "note": "官方音源，2024-06",
  "tags": ["mygo", "anime"],
  "origin": "imported",
  "source": "models/RVC语音模型/MYGO全员/乐奈",
  "created_at": 1791000000
}
```

- **文件删了、sidecar 还在** → 扫描时自然忽略（因为没扫到主权重），不留脏条目。
- **改名**：改文件 + 改 sidecar 一起做；`display_name` 与文件名不一致时以 `display_name` 为准
  （允许「文件名是 `lenai.pth`，界面显示「乐奈」」）。

---

### 4.4 各引擎「参考音频 / 微调权重」能力矩阵（核查结论）

> 回答一个常见疑问：**既然网易 / IndexTTS 在网页上已经能用音色库（参考音频），
> 那它们是不是也能像 GPT-SoVITS 那样加载自训练模型？**
> 核查上游源码后，答案是**两家不一样**。

| 引擎 | 零样本（参考音频） | 微调权重 | 上游训练代码 | 本项目已接入训练？ |
| --- | :---: | :---: | --- | :---: |
| **GPT-SoVITS** | ✅ | ✅ | `s1_train.py`（GPT）+ `s2_train.py`（SoVITS） | ✅ 已接入 |
| **网易 Confucius4-TTS** | ✅ | **✅ 上游有** | `train_t2s.py` + `train_s2a.py`（Lightning） | ❌ **未接入** |
| **IndexTTS 2.5** | ✅ | ❌ 官方无 | **无**（README 自述纯 Zero-Shot） | ❌ 无法接入 |
| **RVC** | ❌ | ✅ | `infer-web.py` | ✅ 已接入 |
| **DDSP-SVC** | ❌ | ✅ | `preprocess.py` → `train_reflow.py` | ❌ 训练入口仍缺（**补做计划见 §4.5 / P5**） |

#### 网易：可以，但要从零接一条训练链路

**证据**（`netease/models-src/Confucius4-TTS/`）：

```
confuciustts/cli/train_t2s.py          文本 → 语义（T2S）训练入口
confuciustts/cli/train_s2a.py          语义 → 声学（S2A）训练入口
confuciustts/cli/t2s_lightning.py      PyTorch Lightning 模块
confuciustts/dataset/t2s_dataset.py    TSV 数据集（文本 + 音频，语义特征用 w2v-bert 现场抽）
config/train_t2s.yaml / train_s2a.yaml 训练配置
```

`config/train_t2s.yaml` 实测关键项：

| 项 | 值 |
| --- | --- |
| 起训权重 | `checkpoints/t2s_model.safetensors`（官方权重，即微调起点） |
| 数据 | `data/train.tsv` + `data/val.tsv`，16 kHz |
| 模型规模 | 24 层 / dim 1280 / 20 heads / vocab 32000 / semantic vocab 8194 |
| 训练 | fp16-mixed、batch_size 2、100 epochs |
| 优化 | AdamW lr 2e-4、cosine、warmup 2000 步、每 2000 步存点 |

**接入需要动三处**：

1. **数据准备**：上游要 TSV（`<音频路径>\t<文本>` 形式）+ 音频文件。
   本项目已有 ASR 批量转写（`JobKind.ASR_TRAIN`，产出逐字文本数据集）——
   正好可以复用它来生成 TSV，这是一条**现成的上游供给链**。
2. **推理侧加载改造**：上游 `confuciustts/cli/inference.py` 里 T2S / S2A 权重是
   **硬编码的 `hf_hub_download(repo_id, filename)`**（本项目 `netease/app/tts_engine.py`
   文件头注释已记录此事实）。要加载自训权重，必须把它改成「可配置的本地路径优先」。
   改动本身很小（`load_state_dict` 的输入源换一下），但属于**改上游代码**，
   要按本项目的既有做法处理（`vendor_paths` / 补丁层，参考 `trainer/app/torch_compat.py` 的先例）。
3. **显存**：推理侧实测常驻 5.4 GB（`tts_required_vram_mb = 5120`）。
   训练侧开销**必须实测**，8 GB 卡上大概率需要 gradient checkpointing + 更小 batch。
   **不要凭参数估算就承诺可跑**（本项目的既有教训：显存判定必须实测，坑 42）。

**建议**：列为独立阶段（P4），先做「数据准备 + 推理侧加载改造 + 单卡冒烟」，
不承诺训练质量，先把链路打通。

#### IndexTTS：不行（官方就是纯零样本）

**证据**：

- 上游 README 首句自述「An Industrial-Level Controllable and Efficient
  **Zero-Shot** Text-to-Speech System」，并写明
  「clones a voice from a single reference audio clip」。
- 仓库 `tools/` 只有 `gpu_check.py` 与 `i18n`，**无训练脚本**。
- 全仓搜索 `pytorch_lightning` / `LightningModule` / `Trainer(` 仅两处命中，
  且都在 vendored 组件里（`s2mel/modules/vocos/helpers.py`、
  `utils/maskgct/models/codec/facodec/facodec_trainer.py`），**不是 IndexTTS 自身的训练**。
- 权重加载为 `from_pretrained(self.model_dir)` + `load_checkpoint(codec.pth)`，
  全部指向固定的 `model_dir`。

**理论上**可以自己写训练（模型是标准 PyTorch，`load_checkpoint` 换个路径就行），
但那是**自研**而非「接入官方能力」—— 要自己准备数据、自己写 Lightning 模块、
自己验证收敛。与网易「上游已经给了训练代码，只需接进来」不是一个量级。

**因此**：`models/index/` 不建。UI 里明确告诉用户「IndexTTS 是纯零样本引擎」。

### 4.5 DDSP-SVC 训练入口补做（阶段 27补4 遗留）

**现状**：`trainer/app/routers/svc.py` 只有
`catalog / pipeline / models{load,unload,upload,delete} / convert / cover` ——
**没有任何 train 端点**。上游 `vendor/ddsp-svc/` 里训练代码是齐的
（`preprocess.py` + `train_reflow.py`），缺的纯粹是**编排层**。

#### 与 RVC 训练的关键差异

| | RVC（已实现，可作参考） | DDSP-SVC（待做） |
| --- | --- | --- |
| 阶段数 | **6 段**：`preprocess → f0 → feature → filelist → train → index` | **2 段**：`preprocess → train` |
| 参数传递 | **命令行参数**逐个传 | **单个 `config.yaml`** 驱动一切 |
| 数据组织 | 平铺音频 + 自己生成 filelist | **固定目录契约**：`data/train/audio/*.wav` + `data/val/audio/*.wav` |
| 推理侧运行方式 | 子进程 + 临时 chdir | **in-process，不用 chdir**（靠绝对路径传参绕开） |
| 训练侧运行方式 | 子进程 + `cwd=vendor 根` | **同样必须子进程 + `cwd=vendor 根`**（见下） |

> **为什么训练必须走子进程、而推理可以 in-process**：
> `svc/bootstrap.py` 的文件头注释已记录 —— 推理侧是自己编排 + 把三处相对路径依赖
> （`pretrain/rmvpe/model.pt`、`vocoder.ckpt`、`encoder_ckpt`）全改成绝对路径传参，
> 所以**不需要 chdir**（GPT-SoVITS 已永久占用 cwd，能不凑热闹就不凑）。
> 但 `preprocess.py` / `train_reflow.py` 是**脚本式**的（`argparse` + `if __name__ == '__main__'`），
> 且 config 里全是相对路径（`pretrain/contentvec/...`、`data/train`、`exp/reflow-test`），
> **没有传绝对路径的入口** → 只能 `cwd=vendor/ddsp-svc` 跑子进程。

#### 上游契约（实测）

**`preprocess.py`**：`-c <config.yaml>`（+ 可选 `-d cpu|cuda`、`-j workers`）
从 `config.data.train_path` / `valid_path` 下的 `audio/` 抽特征（F0 + volume + mel + units），
缓存写进 `config.env.expdir`。

**`train_reflow.py`**：`-c <config.yaml>`，读 cache 训练，
`logger/saver.py::save_model()` 存成 `expdir/<name><_postfix>.pt`。

**`configs/reflow.yaml` 的关键项**（实测）：

| 项 | 值 | 备注 |
| --- | --- | --- |
| `data.sampling_rate` | 44100 | 与输入音频的采样率要对齐 |
| `data.block_size` | 512 | = hop_length |
| `data.duration` | 2 | **训练片段时长，必须小于最短音频** ← 硬约束 |
| `data.f0_extractor` | rmvpe | 与推理侧一致 |
| `data.encoder` | `contentvec768l12tta2x` | 与 `encoder_ckpt` 必须配套 |
| `data.encoder_ckpt` | `pretrain/contentvec/pytorch_model.bin` | 相对路径 |
| `data.train_path` / `valid_path` | `data/train` / `data/val` | **要自己在 expdir 下造** |
| `model.type` | RectifiedFlow | |
| `vocoder.ckpt` | `pretrain/nsf_hifigan/model` | 相对路径 |
| `env.expdir` | `exp/reflow-test` | 产物落点 |
| `train.batch_size` | 48 | **8 GB 卡上大概率要降** |
| `train.epochs` | 100000 | |
| `train.amp_dtype` | fp16 | |

#### 一个必须防的坑：`preprocess.py` 会吞掉单文件异常

```python
# vendor/ddsp-svc/preprocess.py:242
except Exception as e:
    print(f'\n[Error] Task for {file} generated an exception: {e}')
```

**某个音频抽特征失败，脚本照样返回 0**，最终产出一份残缺 cache，
训练时才以莫名其妙的方式失败、或训出坏模型。
这与 RVC 侧「官方脚本裸 `except:` 且恒返回 0」是**同一类坑**（HANDOFF 已有记录），
修法也一样：**不信任返回码，按产物计数判定成败** ——
复用 `vc/training.py::_stage_output_probe()` 的模式，对
`expdir` 下的 cache 文件数做计数。

#### 实现设计

**新增 `trainer/app/svc/training.py`**，结构对齐 `vc/training.py`：

```
STAGES = ("preprocess", "train")     # 只有两段
```

| 阶段 | 命令 | 产物探测 |
| --- | --- | --- |
| `preprocess` | `python preprocess.py -c <生成的 config>`（cwd=vendor 根） | `expdir` 下 cache 文件数 |
| `train` | `python train_reflow.py -c <同一 config>`（cwd=vendor 根） | `expdir/model_*.pt` 是否存在 |

**必须新增的三件事**：

1. **配置生成器** `build_config()`：以 `configs/reflow.yaml` 为模板，
   覆盖 `env.expdir` / `data.train_path` / `data.valid_path` / `data.encoder_ckpt` /
   `vocoder.ckpt` 为**本次任务的绝对路径**（`encoder_ckpt` 与 `vocoder.ckpt` 即使上游写相对路径，
   也建议改写为绝对路径 —— 这样万一将来能在 in-process 里跑，就不用改回来）。
2. **数据目录搭建**：在 expdir 下造
   `data/train/audio/` 与 `data/val/audio/`，把切片后的音频**复制**进去
   （上游只认这个结构，不认我们的 `outputs/` 布局）。
   同时**校验 `duration < 最短片段时长`**，不满足就明确报错并给出建议值
   （照 `_stage_failure_hint()` 的风格给可执行提示）。
3. **产物归位**：训练结束后把 `expdir/model_*.pt` + **saver dump 的 `config.yaml`**
   一起复制到 `models/ddsp-svc/<音色名>/`。
   两者**必须同目录**（`svc/bootstrap.py` 注释已写明：官方 `load_model_vocoder` 按这个约定找配置），
   缺了就是坑 34 的重演。

**端点**（对齐 RVC 的 `/v1/vc/train/plan` + `/v1/vc/train` 两段式）：

```
POST /v1/svc/train/plan   预检：显存、数据量、duration 约束 → 返回计划与风险提示
POST /v1/svc/train        提交任务（JobKind.SVC_TRAIN，走训练池）
```

> `JobKind.SVC_TRAIN` **枚举已存在**（`jobs.py:48`），`TRAIN_POOL` 也已包含它
> （`jobs.py:61`）—— 说明当初就预留了这个位置，只是没接。

**前端**：`SingingConversionPage` 加「训练音色」入口，
复用 `TrainResultCard` 展示训练产物（阶段 27补5 已做好）。

#### 验收标准

1. 上传一批 ≥3 秒的干净人声 → 点训练 → 两段跑完，`models/ddsp-svc/<name>/` 下出现
   `model_*.pt` + `config.yaml`。
2. 在翻唱页能选中该音色并成功转换。
3. **失败可诊断**：故意给一段 <2 秒的音频 → 明确报「片段过短，`duration=2` 需小于最短片段」
   而不是让上游以难懂的方式崩。
4. 显存不足时走既有的显存门禁（`engines.acquire`），不裸奔。

#### 显存预期

上游默认 `batch_size=48` + `cache_all_data` + fp16。**8 GB 卡上必须实测**，
大概率要降 batch 并考虑 `cache_device='cpu'`。
**不凭参数估算承诺可跑**（这是坑 42 的教训：显存判定必须实测）。


---

## 五、网关 API 设计

挂载在 `/api/models`（与 `/api/voicelib` 同级，**网关原生、不依赖 Python 服务**）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/models/catalog` | 类别表 + 每类计数 + 每类根目录绝对路径 |
| `GET` | `/api/models?category=rvc` | 单类模型列表（含 `incomplete` / `missing` 标记） |
| `POST` | `/api/models/import` | 批量导入（multipart，多文件；`category` + 可选 `subdir`） |
| `POST` | `/api/models/rename` | 重命名（联动 companions） |
| `POST` | `/api/models/update` | 改 `display_name` / `note` / `tags` |
| `DELETE` | `/api/models` | 删除（联动 companions，带边界检查） |
| `POST` | `/api/models/reveal` | 在资源管理器打开该类目录 |
| `GET` | `/api/models/raw?path=` | 受限于根目录的只读文件下载（给「下载模型」按钮） |

### 5.1 必须遵守的约束

1. **路径边界检查**（照抄 `svc/catalog.py::delete_model()` 的既有做法）：
   任何写操作解析后的绝对路径**必须落在该类别的根目录内**，否则拒绝。
   这是防止用户传错路径误删别处文件 —— 阶段 27补4 已经为此写过一遍。
2. **导入要保留相对结构**：用户拖一个含子目录的文件夹进来时，
   按 `subdir` 重建（例如把 `MYGO全员/乐奈/` 整块导入 → `models/rvc/MYGO全员/乐奈/`），
   而不是全部拍平。拍平正是当前混乱的来源之一。
3. **`reveal` 用 `explorer.exe`**（Windows）。注意 `server/src/lib/gpuProcesses.ts` 已有
   一个 `explorer.exe` 的白名单条目，说明这类调用在项目里已有先例；
   但仍要**只允许打开注册表里的类别目录**，不接受任意路径。
4. **导入时校验配套文件**：RVC 只给 `.pth` 没给 `.index` → 允许导入但标 `warn`
   （现有 `VoiceLibraryPage` 的「只给 `.pt` 明确提示缺 config，不静默失败」是同样的做法，
   见阶段 27补4）。

### 5.2 与现有 Python 端点的关系

**不删除**现有 `/v1/vc/models/*`、`/v1/svc/models/*`。
理由：加载（`/v1/vc/models/load`）必须由持有引擎的服务做，网关只负责**文件与清单**。
分工：

```
网关 /api/models/*      → 文件系统：列表、导入、改名、删除、打开目录
trainer /v1/vc/models/load → 加载进显存（网关转发）
```

这样避免把「文件管理」和「引擎加载」耦在一起 —— 也符合现有的三层架构。

---

## 六、前端：音色库管理页（升级现有 VoiceLibraryPage）

现有页面 1206 行，已具备：批量导入、单条精导、批量导出、批量删除、编辑弹窗、智能转写。
**不重写，改成多 Tab 容器**：

```
音色库
├─ [参考音频]   ← 现有实现整体搬进这个 Tab（零样本三引擎共用）
├─ [RVC]        ← 新：category=rvc
├─ [DDSP-SVC]   ← 新：category=ddsp-svc
└─ [GPT-SoVITS] ← 新：category=gpt-sovits
```

三个新 Tab 共用同一个 `ModelCategoryPanel` 组件（参数化 category），
能力对齐参考音频 Tab 的成熟交互：

| 能力 | 实现要点 |
| --- | --- |
| 列表 | 卡片：显示名、文件构成、大小、状态徽标（就绪 / 不完整） |
| 拖拽导入 | 复用现有 `useFileDrop` hook（项目统一约定，坑 21/25） |
| 文件夹导入 | 保留相对路径 → 调 `POST /api/models/import` 带 `subdir` |
| 批量选择 | 复选框 + 全选（现有页面已有此模式） |
| 批量重命名 | 弹窗提供三种模式：前缀 / 后缀 / 查找替换，**预览后确认** |
| 批量删除 | 二次确认 + 列出将删除的文件（含 companions） |
| 打开目录 | 调 `reveal`，按钮旁显示该目录绝对路径（可复制） |
| 未识别文件提示 | 扫到「不构成模型的散文件」时列出，提示缺什么配套 |

**批量重命名必须预览**：因为 RVC/DDSP 的改名会联动改 2 个文件，
用户点下去之前要看到「`lenai.pth` + `lenai.index` → `乐奈.pth` + `乐奈.index`」这样的对照表。

---

## 七、前端：各引擎页接线

| 页面 | 数据源改为 |
| --- | --- |
| `VoiceConversionPage`（RVC 变声） | `GET /api/models?category=rvc` |
| `SingingConversionPage`（DDSP-SVC 翻唱） | `GET /api/models?category=ddsp-svc` |
| GPT-SoVITS 相关页 | `category=gpt-sovits`（权重）+ `参考音频`（零样本）**两段式** |
| `NeteaseTtsPage` | `参考音频`（现有 `voices` 列表，不变） |
| `IndexttsTtsPage` | 同上 |

**要点**：GPT-SoVITS 是唯一「两种音色载体都支持」的引擎，
它的选择器需要**显式区分**「零样本（选参考音频）」和「微调模型（选权重）」两条路 ——
这也是当前体验里最容易让用户困惑的地方。

---

## 八、前端：产出记录页（替换历史记录）

### 8.1 数据源合并

| 来源 | 端点 / 位置 | 覆盖 |
| --- | --- | --- |
| 服务端任务 | `GET /v1/jobs`（**不带 kind**，`limit=200`） | 所有本地引擎的推理 + 训练 |
| 模型文件 | `GET /api/models/catalog` | 训练产物、用户导入的权重 |
| 云端合成 | 现有 IndexedDB（`useHistory`） | MiMo（服务端没有） |

统一成一条记录：

```ts
interface OutputRecord {
  id: string;
  source: 'job' | 'model' | 'cloud';
  /** 展示用分类：推理结果 / 训练产物 / 导入模型 / 云端合成 */
  group: 'infer' | 'train' | 'model' | 'cloud';
  engine: string;          // rvc / ddsp-svc / gpt-sovits / uvr5 / asr / mimo
  title: string;
  createdAt: number;
  status?: string;         // job 才有
  artifacts: Array<{       // 可播放 / 可下载的产物
    key: string;
    label: string;
    url?: string;          // 给播放器
    path?: string;         // 本机绝对路径（可复制）
    bytes?: number;
  }>;
}
```

### 8.2 复用 `collectTracks()`（重要）

`app/src/hooks/useVcRunHistory.ts::collectTracks()` 已经解决了**产物路径嵌套形状不一**的坑：

- `vc_infer`：路径在**顶层**（`output` + `urls.output`）
- `svc_infer`：路径嵌在 **`artifacts.artifacts`** 内层、`urls` 在外层
- 且必须过滤掉 `sample_rate` / `stages` / `info` 这类会被误当产物的字段

→ **把这个函数提到 `app/src/lib/jobArtifacts.ts`**，让 `useVcRunHistory` 与产出记录页共用。
不提取的话，产出记录页必然重踩同一个坑（而且这次是 8 种 job kind，面积更大）。

### 8.3 页面结构

```
产出记录
├─ 筛选栏：全部 / 生成结果 / 训练产物 / 模型文件 / 云端合成
│          + 引擎筛选（rvc / ddsp-svc / gpt-sovits / uvr5 / asr / 网易 / IndexTTS / MiMo）
│          + 关键词搜索
├─ 列表：每条 = 标题 + 引擎徽标 + 时间 + 状态 + 产物（内联播放器 + 可复制的本地路径）
└─ 空态：引导去各页面生成
```

**「训练产物」这一组直接复用 `TrainResultCard` / `RunResultCard` 的渲染方式**
（阶段 27补5 刚做的：逐轨内联 `<audio>` + 可点击复制的本机路径）。

### 8.4 导航改造

侧栏「历史记录」→ 改名「产出记录」。
MiMo 的本地记录**并入**这个页面（而不是删掉）—— 它是唯一的云端产物来源。

---

## 九、迁移方案（把现有散落模型归位）

**必须做成「一次性、幂等、可回滚」的脚本**，且**先 dry-run 打印计划**。

### 9.1 迁移映射

| 从 | 到 | 动作 |
| --- | --- | --- |
| `trainer/.data/vc/models/*.pth` + 配对 `.index` | `models/rvc/<name>/` | 移动（配对文件一起） |
| `trainer/.data/svc/models/<name>/` | `models/ddsp-svc/<name>/` | 移动（整个目录） |
| `models/RVC语音模型/<组>/<角色>/` | `models/rvc/<组>/<角色>/` | 移动（**保留原有嵌套**） |
| `models/checkpoints/**`（GPT-SoVITS 产物） | `models/gpt-sovits/<name>/` | 移动（先盘点再定） |
| `voicelib/` | **不动** | — |

### 9.2 迁移脚本要求

1. **dry-run 优先**：先打印「将从 A 移到 B（N 个文件，X MB）」，用户确认后再执行。
2. **冲突不覆盖**：目标已存在同名 → 跳过并报告，不静默覆盖。
3. **移动用 `fs.renameSync` 优先**，跨盘失败再退化为「复制 + 校验 + 删除」。
4. **写迁移日志** `models/.migration-log.json`（from/to/时间/结果），支持按日志回滚。
5. **改完通知用户重启**：`trainer/app/config.py` 的目录解析有缓存假设，
   且 `vc/models.py` 的扫描路径要同步改成新根目录（见 §10 第 2 条）。

---

## 十、分期实施计划

### P0 —— 打通「看得见」（最小可用）✅ 已完成（2026-10-09）

1. ~~网关新增 `modelRegistry.ts` + `/api/models/catalog` + `GET /api/models`~~ ✅
2. ~~新建 `models/{rvc,ddsp-svc,gpt-sovits,netease}` 四个目录~~ ✅
3. ~~把 RVC 扫描根从 `trainer/.data/vc/models` 改为 `models/rvc/`（保留旧路径兼容读取）~~ ✅
4. ~~音色库页加 Tab（先只做「列表 + 打开目录 + 删除」）~~ ✅
5. ~~验收：`models/RVC语音模型/` 那批 MYGO/Mujica 模型在 WebUI 里可见可加载~~ ✅

**实测结果**：

| 项 | 改前 | 改后 |
| --- | --- | --- |
| 模型可见数 | 5（只有 `.data/vc/models/` 的扁平文件） | **18**（含嵌套目录里的 10 个） |
| `.index` 配对 | 靠「路径含模型名」启发式，嵌套下误配 | 同目录 + 同 basename 优先，**6/6 正确** |
| 嵌套模型可加载 | ❌ 拼不出路径（10/10 失败） | ✅ `deng.pth` 从 `MYGO全员/高松灯/` 成功加载 |

**实施中发现并修正的两处设计偏差**（原方案没预料到）：

1. **必须加「兼容读取的旧位置」**，否则改扫描根会让既有模型全部「消失」。
   最终定为三根并存：`models/rvc/`（规范）→ `models/RVC语音模型/`（用户的组织方式）→
   `trainer/.data/vc/models/`（P0 前的旧根）。
   **网关与 trainer 的根列表必须逐一对应**，否则会出现「引擎能加载但界面看不见」的错位
   （实测：网关只配了 1 个旧根时是 10 个，trainer 是 18 个；补齐后两侧都是 18）。

2. **`find_model` 必须「逐根先精确后递归」，不能「所有根先精确再统一递归」**。
   原写法下 `.data/vc/models/lenai.pth`（扁平）会抢在
   `models/RVC语音模型/MYGO全员/乐奈/lenai.pth`（嵌套、更高优先级）之前命中 ——
   因为「相对路径」这一步跨所有根跑完了才轮到递归匹配。
   改成逐根闭环后，根优先级才真正生效。

**关键实现点（供后续阶段参考）**：

- `VC.get_vc(sid)` 内部拼 `f'{weight_root}/{sid}'`，所以**加载时要把 `weight_root`
  设成模型自己所在的目录**、`sid` 只传文件名 —— 这是嵌套模型能加载的关键，
  且**无需改动上游代码**。
- 重复检测用 `(主权重文件名, 大小)`，不做全量 hash（几百 MB 会卡死界面）。
  实测正确标出了 `.data/vc/models/sushi.pth` 与 `models/RVC语音模型/MYGO全员/素世/sushi.pth` 这一对。
- 删除会**联动删掉配套文件**（实测一次删除移除了 `.pth` + `.index` 两个文件）。
- 路径边界检查覆盖**全部搜索根**（不只是规范根），否则用户删不掉旧位置里的垃圾模型。
  实测 `category: "../../etc"` 被拒（`MODEL_CATEGORY_UNKNOWN`）。

**遗留到 P1**：批量导入、批量重命名、sidecar 元数据编辑、迁移脚本。
（P0 只做了「列表 + 打开目录 + 删除 + 重新扫描」，导入仍走各引擎页原有的上传入口。）


### P1 —— 打通「管得住」✅ 已完成（2026-10-09）

6. ~~批量导入（含文件夹、保留相对结构）+ 重复检测提示（§3.4）~~ ✅
7. ~~批量重命名（联动 companions）+ 预览~~ ✅
8. ~~sidecar `.meta.json`（显示名 / 备注 / 标签）~~ ✅
9. ~~「重新扫描」按钮 + 本地拖入后的重复徽标~~ ✅（P0 已做）
10. ~~迁移（把旧位置收口到规范根）~~ ✅
11. ~~验收~~ ✅

**接口**（`/api/models`）：`POST /import`（流式落盘，2 GB 上限）、
`POST /rename`（联动配套）、`POST /update`（元数据）、
`POST /migrate`（**默认 dry-run**，要真搬必须显式 `dry_run: false`）。

**前端**（`ModelCategoryPanel` + 新增 `ModelEditDialog`）：
「导入文件 / 导入文件夹 / 打开目录 / 重新扫描」四个按钮、勾选后「批量重命名」、
单条「编辑」弹窗（文件名 + 显示名 + 标签 + 备注）、迁移确认弹窗（先摊计划再执行）。

**两条导入路径并列、互不冲突**（都落在同一个类别目录里）：
文件管理器拖入 → 点「重新扫描」；或面板上传 → 立即出现。
靠**同一个注册表**统一，不存在「网页导入的模型在别处」。

**实测结果**（`.tmp/verify_model_manage.py`，**28/28 全绿**）：

| 项 | 结果 |
| --- | --- |
| 导入保留子目录（不拍平） | ✅ `rvc/_p1verify_组/_p1verify_子/verify.pth` |
| 重复检测（同名同大小） | ✅ 409 + 结构化 `conflict` |
| `keep_both` | ✅ 自动 `-1` 后缀 |
| 重命名联动配套 | ✅ `.pth` + `.index` 一起改，中文名未损坏 |
| 元数据 | ✅ 显示名 / 备注 / 标签落盘并在列表生效 |
| 路径穿越 | ✅ `../../../evil` 被剥成 `evil`，未逃出类别根；`.exe` 被拒（400） |
| 迁移计划 | ✅ 每项待搬文件同属一个目录（按模型搬，非按目录搬） |
| **真实迁移 18 个 RVC 模型** | ✅ 全部搬到 `models/rvc/`，结构保留，两个旧根清空，迁移后仍可加载 |

### P1 实施中修掉的两个真 bug

1. **`assertInsideCategory` 把「路径 == 根本身」判成越界** ——
   多写了一个 `relative !== ''`，导致扁平旧根里的 8 个模型全部迁移失败
   （报「路径不在任何搜索目录内」）。已改为 `relative === ''` 也算界内。
2. **迁移按「目录」搬而不是按「模型的文件」搬** ——
   扁平布局下多个模型共用一个目录，按目录搬会把同目录里别的模型一起卷走。
   已改为只搬 `model.files` + 它自己的 sidecar。

### 迁移后的现状（需要用户决策的一点）

迁移后仍有 **4 对疑似重复**（界面标「疑似重复」徽标）：
`models/rvc/{lenai,sushi,lixi,aiyi}.pth`（原先在 `.data/vc/models/` 的扁平副本）
与 `models/rvc/MYGO全员/<角色>/…`（嵌套的原件）同名同大小。
迁移只搬不删，去重留给用户 —— 面板已把每一对标出来，删掉多余的即可。


### P2 —— 产出记录页

12. 提取 `collectTracks()` 到 `app/src/lib/jobArtifacts.ts`。
13. 新建产出记录页（三源合并），侧栏改名。
14. 把 MiMo 的本地记录并入。
15. **验收**：跑一次 RVC 变声 + 一次翻唱 + 一次训练，三条记录都出现在产出记录页，
    且各自产物能播放、能复制本机路径。

### P3 —— 体验收尾

16. 各引擎页接新数据源（含 GPT-SoVITS 的「零样本 / 微调模型」两段式选择器）。
17. 「未识别文件」提示、缺配套文件的引导。
18. 更新 `HANDOFF.md` / `PROGRESS.md`。

### P4 —— 网易微调接入（独立立项，见 §4.4）

19. 数据准备：复用 ASR 批量转写（`JobKind.ASR_TRAIN`）产出的文本数据集 → 生成上游要的 TSV。
20. 推理侧加载改造：把 `confuciustts/cli/inference.py` 里硬编码的 `hf_hub_download`
    改为「本地路径优先」，让引擎能加载 `models/netease/` 下的自训权重。
21. 接训练入口（`train_t2s.py` / `train_s2a.py`）+ 显存实测 + 单卡冒烟。
22. `models/netease/` 的 UI 从「预留 · 尚未接入」改为正常可用。
23. **验收**：小样本微调能跑完并存点；推理侧能选中该权重并出声。

> **注意**：P4 与 P0–P3 无依赖关系，可以并行或延后。
> 先做 P0–P3 的收益（看得见 / 管得住 / 产出可查）远大于 P4。

### P5 —— DDSP-SVC 训练入口补做（阶段 27补4 遗留，详见 §4.5）

24. 新增 `trainer/app/svc/training.py`（两段：`preprocess` → `train`），
    结构对齐 `vc/training.py`，复用其 `_run_command` / `_stage_output_probe` / `_stage_failure_hint`。
25. 配置生成器 `build_config()`：以 `configs/reflow.yaml` 为模板，路径项全部改写为绝对路径。
26. 数据目录搭建：在 expdir 下造 `data/{train,val}/audio/`，**并校验 `duration < 最短片段`**。
27. 产物归位：`expdir/model_*.pt` + saver dump 的 `config.yaml` → `models/ddsp-svc/<name>/`（**必须同目录**）。
28. 端点 `/v1/svc/train/plan` + `/v1/svc/train`（`JobKind.SVC_TRAIN` 枚举与训练池**已存在**，直接接）。
29. 前端 `SingingConversionPage` 加训练入口，复用 `TrainResultCard`。
30. **验收**：见 §4.5 的四条标准（能训出可加载的音色、失败可诊断、走显存门禁、显存实测）。

> **与 P4 的关系**：两者都是「补齐训练入口」，但**互不依赖**。
> 建议顺序：**P5 优先于 P4** —— DDSP-SVC 的上游代码已经完整可用，纯编排工作，
> 确定性高；网易那条要改上游 `inference.py` 的硬编码加载路径，不确定性更大。



---

## 十一、风险与坑（预判）

| 风险 | 说明 | 对策 |
| --- | --- | --- |
| **改动扫描根会「模型消失」** | 用户现有 `.data/vc/models/` 里的模型如果只改根目录不改迁移，会全部不可见 | P0 阶段**双根读取**（新根优先、旧根兼容），P1 迁移后再移除旧根 |
| **`.index` 配对失效** | 嵌套目录下现有 `find_index_for()` 的「路径含模型名」启发式会误配 | 换成「同目录 + 同 basename」，并在迁移后跑一次配对自检 |
| **DDSP-SVC 缺 `config.yaml`** | 加载直接失败（坑 34） | 扫描时标 `incomplete` 并显示，不隐藏；导入时明确提示 |
| **重命名联动漏文件** | RVC 只改 `.pth` 会导致索引静默失效、听感变差（不报错） | 联动改名 + 批量重命名强制预览对照表 |
| **产出记录的产物形状不一** | 8 种 job kind 的 `artifacts` 结构不同（`vc_infer` 扁平 vs `svc_infer` 嵌套） | 必须先提取 `collectTracks()`，禁止各页重写解析 |
| **`/v1/jobs` 默认 limit=50** | 产出记录页会「看起来只有 50 条」 | 显式传 `limit=200`（服务端上限），并在 UI 显示「已显示最近 N 条」 |
| **Windows 路径与中文名** | 项目已有坑 39（`torch.save` 对奇数个非 ASCII 字符失败）、坑 36（写盘） | 重命名走**文件系统 API**（`fs.renameSync`），不经 torch |
| **`explorer.exe` 调用** | 任意路径会变成「打开任意目录」的安全口子 | 只接受注册表里的 category key，路径由服务端拼 |
| **重复检测用全量 hash 会卡死** | 模型几百 MB，导入时算 hash 会让界面假死 | 用 `(文件名, 大小)` 指纹，不做全量 hash（§3.4） |
| **文件夹导入被拍平** | 拍平正是当前混乱的来源 | 按原相对路径重建，不拍平 |
| **网易微调显存未知** | 推理常驻 5.4 GB，训练侧开销未实测 | P4 必须实测，不凭参数估算承诺可跑（坑 42 的教训） |
| **改上游 inference 代码** | `hf_hub_download` 硬编码，改了才能加载自训权重 | 走补丁层（参考 `trainer/app/torch_compat.py` 先例），不直接改 `models-src/` 原件 |
| **DDSP-SVC 的 `preprocess.py` 吞单文件异常** | `except Exception` 后只 print 不抛，脚本照样返回 0 → 残缺 cache 到训练阶段才炸 | **不信任返回码**，按 `expdir` 下 cache 文件数探测成败（复用 `_stage_output_probe` 模式） |
| **DDSP-SVC 训练必须 chdir** | config 里全是相对路径（`pretrain/...`、`data/train`、`exp/...`），上游没有传绝对路径的入口 | 子进程 + `cwd=vendor/ddsp-svc`（与推理侧的 in-process 设计不同，别混淆） |
| **DDSP-SVC `data.duration` 约束** | 训练片段时长必须**小于最短音频**，否则上游以难懂的方式失败 | 切片阶段校验 + 明确报错给建议值 |
| **DDSP-SVC 产物必须同目录** | `.pt` 与 saver dump 的 `config.yaml` 必须同目录，缺了加载不了（坑 34） | 归位时两个文件一起复制，并做配对自检 |

---

## 十二、与现有约定的对齐检查

- ✅ 复用 `useFileDrop`（坑 21/25：磁盘路径不能当 URL、拖拽统一入口）
- ✅ 复用 `useResultStack` 之外的新链路要走独立 hook（坑 18）
- ✅ 显存门槛/取值范围仍以服务端为准（坑 19）
- ✅ 网关 GET 状态接口「读时现探」（坑 47，阶段 27补7）
- ✅ 新增服务/类别要配 `hints`（坑 42–45 的进程归属）
- ✅ 改后端响应结构同步改 `app/src/types/*.ts`（契约同步）
- ✅ 每阶段结束更新 `PROGRESS.md` 六要素 + `HANDOFF.md` 已知坑

---

## 附：本次核查确认的关键事实（供实现时对照）

| 事实 | 证据位置 |
| --- | --- |
| RVC 只扫一层 `.pth` | `trainer/app/vc/bootstrap.py::models_dir()` |
| RVC `.index` 用路径含名配对 | `trainer/app/vc/models.py::find_index_for()` |
| DDSP-SVC 扫两个目录 | `trainer/app/svc/catalog.py::model_dirs()` |
| DDSP-SVC 无 rename 端点 | `trainer/app/routers/svc.py`（仅 load/unload/upload/delete） |
| `/v1/jobs` 支持全类型 | `trainer/app/api.py:982`（`kind` 可选，limit ≤ 200） |
| 参考音频是唯一的跨引擎共享层 | `server/src/services/voiceLibrary.ts` 文件头注释 |
| 历史记录只记 MiMo | `app/src/types/index.ts:27`（`TtsMode` 仅 3 个云端模式） |
| 产物路径嵌套坑已解决过一次 | `app/src/hooks/useVcRunHistory.ts::collectTracks()` |
| **网易上游有微调流水线** | `netease/models-src/Confucius4-TTS/confuciustts/cli/train_t2s.py`、`config/train_t2s.yaml` |
| **网易推理侧权重走硬编码 HF 下载** | `confuciustts/cli/inference.py`（`hf_hub_download` + `load_state_dict`）；本项目 `netease/app/tts_engine.py` 文件头注释已记录 |
| **IndexTTS 无训练代码** | 上游 README 自述 Zero-Shot；`tools/` 仅 `gpu_check.py` + `i18n`；全仓无训练脚本 |
| GPT-SoVITS 双训练入口 | `/health` 的 `entries` 含 `train_s1`（s1_train.py）与 `train_s2`（s2_train.py） |
| **voicelib 支持从磁盘路径引用（不复制）** | `voiceLibrary.ts::createVoiceFromPath()`、`origin: 'external'` |
| **DDSP-SVC 无任何 train 端点** | `trainer/app/routers/svc.py` 全部 8 个端点里无 train |
| **DDSP-SVC 训练是两段式、config 驱动** | `vendor/ddsp-svc/preprocess.py` + `train_reflow.py`，均只收 `-c config.yaml` |
| **DDSP-SVC 数据目录契约** | `configs/reflow.yaml` 的 `data.train_path: data/train`（该目录下要建 `audio/`） |
| **DDSP-SVC 吞单文件异常** | `vendor/ddsp-svc/preprocess.py:242`（`except Exception` 只 print） |
| **DDSP-SVC 推理 in-process、训练需 chdir** | `trainer/app/svc/bootstrap.py` 文件头注释（三处相对路径改绝对路径传参） |
| **`JobKind.SVC_TRAIN` 已预留** | `trainer/app/jobs.py:48`（枚举）+ `:61`（已在 `TRAIN_POOL`） |
| **RVC 训练可作编排参考** | `trainer/app/vc/training.py`（`STAGES` 六段 + `_stage_output_probe` + `_stage_failure_hint`） |
