import type { SynthesizeResponse } from '@/types';
import type { TtsProvider } from './types';

/**
 * 自托管 Provider。
 *
 * 当目标语言超出 MiMo 能力范围（如日语、韩语）时，可部署开源模型
 * （GPT-SoVITS / CosyVoice 2 / XTTS-v2 等）并套一层约定好的 HTTP 服务接入。
 *
 * 约定契约：
 *   POST {endpoint}/tts
 *   Body: { model, mode, text, instruction, voice, language }
 *   Response: { audio: <base64 wav> } 或 { segments: [{ index, audio, bytes, durationSec, text }] }
 *
 * 服务端需要自行开放 CORS（浏览器直连场景），或部署在与页面同源的地址下。
 */

/**
 * 已知的自托管模型预设，用于填充语言范围。
 *
 * 注意：**GPT-SoVITS 不在这个列表里** —— 它在本项目中有独立的一等 Provider
 * （`providers/gpt-sovits.ts`，含音色库、批量合成与训练）。
 * 这里保留的是「你自己部署了某个服务，并按约定契约暴露 HTTP 接口」的场景。
 */
export const SELFHOSTED_PRESETS: {
  id: string;
  label: string;
  languages: string[];
  note: string;
}[] = [
  {
    id: 'cosyvoice2',
    label: 'CosyVoice 2',
    languages: ['zh', 'en', 'ja', 'ko', 'yue'],
    note: '阿里开源，3 秒克隆，支持多语言与方言',
  },
  {
    id: 'xtts-v2',
    label: 'XTTS-v2',
    languages: ['en', 'es', 'fr', 'de', 'it', 'pt', 'ja', 'ko', 'zh'],
    note: '覆盖 17 种语言，跨语种克隆',
  },
  {
    id: 'f5-tts',
    label: 'F5-TTS',
    languages: ['zh', 'en'],
    note: '非自回归架构，推理快，支持流式',
  },
  {
    id: 'custom',
    label: '自定义服务',
    languages: [],
    note: '自行实现上述契约，并在设置中声明语言',
  },
];

interface SelfHostedResponse {
  audio?: string;
  duration?: number;
  segments?: Array<{ index: number; audio: string; bytes: number; durationSec: number; text: string }>;
}

export const selfHostedProvider: TtsProvider = {
  id: 'selfhosted',
  name: '自托管模型',
  summary: '部署开源模型（支持日语、韩语等）后接入，突破官方语种限制',
  languages: [],
  requiresKey: false,
  defaultModel: 'custom',
  capabilities: { preset: true, design: false, clone: true },
  fields: [
    {
      key: 'endpoint',
      label: '服务地址',
      placeholder: 'https://your-server.example.com/tts',
      hint: '需实现 POST /tts 契约，并允许跨域访问',
      required: true,
    },
    {
      key: 'model',
      label: '模型名称',
      placeholder: 'gpt-sovits / cosyvoice2 / xtts-v2 …',
      hint: '透传给你的服务，便于其选择具体模型',
    },
    {
      key: 'languages',
      label: '支持的语言',
      placeholder: 'ja, ko, zh, en',
      hint: '用逗号分隔语言代码，用于按语言推荐模型',
    },
  ],
  models: [
    {
      id: 'custom',
      label: '自托管服务',
      mode: 'preset',
      languages: [],
      note: '语言范围由你的服务决定，需在设置中声明',
    },
  ],
  notes: [
    '适合需要日语、韩语等 MiMo 未开放语种的场景',
    '需自备推理服务器（推荐 8GB 以上显存）',
    '服务端必须开放 CORS，否则浏览器无法直连',
  ],
  synthesize: async (params, context) => {
    const endpoint = (context.fields?.endpoint ?? '').trim();
    if (!endpoint) {
      throw new Error('尚未配置自托管服务地址，请在「设置」中填写');
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: context.fields?.model?.trim() || params.model,
        mode: params.mode,
        text: params.text,
        instruction: params.instruction,
        voice: params.voice,
        language: params.language,
      }),
    });

    if (!response.ok) {
      throw new Error(`自托管服务返回 ${response.status}：${(await response.text()).slice(0, 200)}`);
    }

    const data = (await response.json()) as SelfHostedResponse;

    // 兼容两种返回：直接给单段音频，或给出分段数组
    if (data.segments?.length) {
      const bytes = data.segments.reduce((sum, segment) => sum + (segment.bytes || 0), 0);
      const duration = Number(data.segments.reduce((sum, s) => sum + (s.durationSec || 0), 0).toFixed(1));
      return {
        segments: data.segments,
        mimeType: 'audio/wav',
        format: 'wav',
        model: context.fields?.model?.trim() || params.model,
        bytes,
        durationSec: duration,
        segmented: data.segments.length > 1,
        segmentCount: data.segments.length,
        mode: params.mode,
        text: params.text,
      } satisfies SynthesizeResponse;
    }

    if (!data.audio) {
      throw new Error('自托管服务未返回音频数据');
    }

    const estimateBytes = Math.floor((data.audio.length * 3) / 4);
    return {
      segments: [
        {
          index: 0,
          audio: data.audio,
          bytes: estimateBytes,
          durationSec: data.duration ?? Number((estimateBytes / 48_000).toFixed(1)),
          text: params.text,
        },
      ],
      mimeType: 'audio/wav',
      format: 'wav',
      model: context.fields?.model?.trim() || params.model,
      bytes: estimateBytes,
      durationSec: data.duration ?? Number((estimateBytes / 48_000).toFixed(1)),
      segmented: false,
      segmentCount: 1,
      mode: params.mode,
      text: params.text,
    } satisfies SynthesizeResponse;
  },
};
