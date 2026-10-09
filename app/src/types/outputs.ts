import type { HistoryRecord } from './index';

/**
 * 产出记录页的统一记录。
 *
 * 为什么要统一：改前「历史记录」只显示 MiMo（数据来自浏览器 IndexedDB），
 * 而本地引擎的产物**一直都在服务端** `trainer/.data/jobs/*.json` 里 ——
 * 不是没记录，只是没有页面去读它（方案 §1.4）。
 *
 * 三源合并后统一成这一种形状，界面只认它：
 *   * `job`   —— 服务端任务（推理 / 训练），`GET /v1/jobs`；
 *   * `model` —— 本地模型文件，`GET /api/models/*`；
 *   * `cloud` —— 云端合成，浏览器 IndexedDB（音频是 Blob，要按需读取）。
 */

/** 展示分组 */
export type OutputGroup = 'infer' | 'train' | 'model' | 'cloud';

/** 一条产物：能给 `url` 就内联播放，能给 `path` 就让用户复制去资源管理器定位 */
export interface OutputArtifact {
  key: string;
  label: string;
  url?: string;
  path?: string;
  bytes?: number;
}

export interface OutputRecord {
  /** 三源 id 不会撞（job id / `model:<id>` / 云端记录 id） */
  id: string;
  source: 'job' | 'model' | 'cloud';
  group: OutputGroup;
  /** 引擎 key，显示时查 `ENGINE_LABELS` */
  engine: string;
  title: string;
  createdAt: number;
  /** 任务状态 / 模型状态，云端记录没有 */
  status?: string;
  /** 副标题：失败原因、缺的配套文件、音色名等 */
  note?: string;
  artifacts: OutputArtifact[];
  /** 仅云端记录：音频在 IndexedDB 里，展开时才读（避免一次读库几百 MB） */
  cloud?: HistoryRecord;
}
