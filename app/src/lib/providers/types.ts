/**
 * 语音合成 Provider 抽象层。
 *
 * 目标：在不改动 MiMo 既有链路的前提下，支持按语言需求切换不同模型。
 * 每个 Provider 描述自己的模型、语言范围、能力与配置项，
 * 并负责把统一的合成参数翻译成各自的协议（HTTP 或 WebSocket）。
 */

import type { PresetVoice, SynthesizeResponse, TtsMode } from '@/types';

/** 单个可选模型 */
export interface TtsModel {
  /** 模型标识，如 mimo-v2.5-tts */
  id: string;
  /** 界面显示名 */
  label: string;
  /** 所属能力模式 */
  mode: TtsMode;
  /** 该模型支持的语言 */
  languages: string[];
  /** 预置音色（仅 preset 模式需要） */
  voices?: PresetVoice[];
  /** 备注，例如使用限制 */
  note?: string;
}

/** Provider 除 API Key 之外需要的配置项 */
export interface ProviderField {
  key: string;
  label: string;
  placeholder: string;
  hint?: string;
  required?: boolean;
}

/** Provider 能力声明 */
export interface ProviderCapabilities {
  preset: boolean;
  design: boolean;
  clone: boolean;
}

/** 一次合成所需的上下文 */
export interface SynthesisContext {
  /** 用户为该 Provider 配置的密钥（BYOK；自托管可为空） */
  apiKey: string;
  /** 自定义服务端地址或接口地址 */
  baseUrl?: string;
  /** Provider 自定义字段的值，如自托管地址 */
  fields?: Record<string, string>;
}

/** Provider 定义 */
export interface TtsProvider {
  id: string;
  name: string;
  /** 一句话简介，用于选择界面 */
  summary: string;
  /** 该 Provider 覆盖的语言（用于按语言推荐） */
  languages: string[];
  models: TtsModel[];
  /** 默认模型 id */
  defaultModel: string;
  capabilities: ProviderCapabilities;
  /** 是否需要配置密钥 */
  requiresKey: boolean;
  /** 除密钥外的额外配置 */
  fields?: ProviderField[];
  /** 获取密钥的入口（可选） */
  keyUrl?: string;
  /** 说明文字，展示在选择卡片上 */
  notes?: string[];

  /**
   * 执行合成。
   * @param params 统一的合成参数
   * @param context 该 Provider 的配置上下文
   */
  synthesize(
    params: {
      mode: TtsMode;
      model: string;
      text: string;
      instruction?: string;
      voice?: string;
      optimizeTextPreview?: boolean;
      autoSegment?: boolean;
      language?: string;
    },
    context: SynthesisContext,
  ): Promise<SynthesizeResponse>;
}

/** 语言能力矩阵：用于界面展示与按语言推荐模型 */
export interface LanguageOption {
  code: string;
  label: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'zh', label: '中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'yue', label: '粤语' },
  { code: 'fr', label: 'Français' },
  { code: 'de', label: 'Deutsch' },
  { code: 'ru', label: 'Русский' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'it', label: 'Italiano' },
  { code: 'th', label: 'ไทย' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'vi', label: 'Tiếng Việt' },
];
