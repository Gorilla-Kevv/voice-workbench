import { api } from '../api';
import { FALLBACK_PRESET_VOICES } from '../constants';
import type { TtsProvider } from './types';

/**
 * 小米 MiMo Provider。
 *
 * 内部复用既有的合成链路（proxy 模式走自建后端，direct 模式浏览器直连），
 * 本文件只做参数适配，不改动任何既有逻辑。
 */
export const mimoProvider: TtsProvider = {
  id: 'mimo',
  name: '小米 MiMo',
  summary: '官方预置音色，中文（含方言）与英文，支持音色设计与声音克隆',
  languages: ['zh', 'en', 'yue'],
  requiresKey: true,
  keyUrl: 'https://platform.xiaomimimo.com/console/api-keys',
  defaultModel: 'mimo-v2.5-tts',
  capabilities: { preset: true, design: true, clone: true },
  models: [
    {
      id: 'mimo-v2.5-tts',
      label: '通用语音合成',
      mode: 'preset',
      languages: ['zh', 'en', 'yue'],
      voices: FALLBACK_PRESET_VOICES,
      note: '9 个官方音色，支持风格标签与唱歌模式',
    },
    {
      id: 'mimo-v2.5-tts-voicedesign',
      label: '音色设计',
      mode: 'design',
      languages: ['zh', 'en'],
      note: '用文字描述生成音色，可描述外语口音',
    },
    {
      id: 'mimo-v2.5-tts-voiceclone',
      label: '声音克隆',
      mode: 'clone',
      languages: ['zh', 'en'],
      note: '上传 mp3/wav 样本（≤10MB）零样本复刻',
    },
  ],
  notes: [
    '官方开放语言：中文（普通话）、东北话 / 四川话 / 河南话 / 粤语、台湾腔、English',
    '日语、韩语等其它语种官方暂未开放',
  ],
  synthesize: async (params, context) =>
    api.synthesize({
      mode: params.mode,
      text: params.text,
      instruction: params.instruction,
      voice: params.voice,
      optimizeTextPreview: params.optimizeTextPreview,
      autoSegment: params.autoSegment,
      apiKey: context.apiKey,
      baseUrl: context.baseUrl,
    }),
};
