import { RequestError } from '@/lib/errors';
import { DEFAULT_SOVITS_BASE, sovitsApi } from '@/lib/sovits';
import type { SynthesizeResponse } from '@/types';
import type { TtsProvider } from './types';

/**
 * GPT-SoVITS 本地 Provider。
 *
 * 与 MiMo 的本质差异，决定了这里的能力声明：
 *
 * | | MiMo | GPT-SoVITS |
 * | --- | --- | --- |
 * | 音色来源 | 官方 9 个预置音色 | **没有内置音色**，必须提供 3~10 秒参考音频 + 其转写文本 |
 * | 音色设计 | 支持（voicedesign） | 不支持 —— 它只能复制已有音色 |
 * | 语言 | 中英 + 方言标签 | 中英日韩粤，且可跨语言（中文音色说日语） |
 * | 训练 | 无 | **支持少样本微调**，产出专属权重 |
 * | 数据 | 上传到云端 | 全程留在本机 |
 *
 * 因此 `capabilities.design` 为 false，`clone` 与 `preset` 都为 true
 * （在这套模型里，preset 指的是「用已注册的音色库音色」，clone 指的是「临时指定的参考音频」）。
 */
export const gptSovitsProvider: TtsProvider = {
  id: 'gpt-sovits',
  name: 'GPT-SoVITS（本地）',
  summary: '本地部署、数据不出机；5 秒样本零样本克隆，1 分钟语料少样本微调，支持中英日韩粤跨语言',
  languages: ['zh', 'en', 'ja', 'ko', 'yue'],
  requiresKey: false,
  defaultModel: 'gpt-sovits-v2proplus',
  capabilities: { preset: true, design: false, clone: true },
  fields: [
    {
      key: 'endpoint',
      label: '本地服务地址',
      placeholder: DEFAULT_SOVITS_BASE,
      hint: '默认经同源网关 /api/sovits 访问；若 Python 服务跑在别处，可填 http://127.0.0.1:9881',
    },
    {
      key: 'voice',
      label: '默认音色',
      placeholder: '音色库中的音色 ID',
      hint: '在「音色库」页面导入参考音频后，把音色 ID 填在这里即可作为默认音色',
    },
    {
      key: 'version',
      label: '模型版本',
      placeholder: 'v2ProPlus',
      hint: 'v1 / v2 / v2Pro / v2ProPlus / v3 / v4；v3、v4 不支持流式',
    },
    {
      key: 'prompt_lang',
      label: '参考音频语种',
      placeholder: 'zh',
      hint: 'zh / en / ja / ko / yue，需与参考音频实际语种一致',
    },
    {
      key: 'text_split_method',
      label: '文本切分方式',
      placeholder: 'cut5',
      hint: 'cut0 不切分 → cut5 逗号级切分；长文本推荐 cut5',
    },
    {
      key: 'speed_factor',
      label: '语速倍率',
      placeholder: '1.0',
      hint: '0.5 ~ 2.0；非 1.0 会自动关闭分桶处理',
    },
  ],
  models: [
    {
      id: 'gpt-sovits-v2proplus',
      label: 'v2 ProPlus · 通用合成',
      mode: 'preset',
      languages: ['zh', 'en', 'ja', 'ko', 'yue'],
      note: '官方当前主推版本，含说话人向量，相似度最高',
    },
    {
      id: 'gpt-sovits-v2pro',
      label: 'v2 Pro',
      mode: 'preset',
      languages: ['zh', 'en', 'ja', 'ko', 'yue'],
      note: 'v2 增强版，显存占用略低',
    },
    {
      id: 'gpt-sovits-v2',
      label: 'v2 · 兼容性最好',
      mode: 'preset',
      languages: ['zh', 'en', 'ja', 'ko', 'yue'],
      note: '社区权重最多，老模型兼容性好',
    },
    {
      id: 'gpt-sovits-v3',
      label: 'v3 · 新声码器',
      mode: 'preset',
      languages: ['zh', 'en', 'ja', 'ko', 'yue'],
      note: '音质更好，但不支持流式推理',
    },
    {
      id: 'gpt-sovits-clone',
      label: '零样本克隆',
      mode: 'clone',
      languages: ['zh', 'en', 'ja', 'ko', 'yue'],
      note: '每条请求指定参考音频，不写入音色库',
    },
  ],
  notes: [
    '没有内置音色：请先在「音色库」导入一段 3~10 秒、单人、无背景音的参考音频',
    '跨语言合成：可以用中文音色去读日语/韩语文本，反之亦然',
    '首次合成需要加载模型（约 30~90 秒），之后会常驻内存',
    '批量合成本地串行执行：一次提交几百条文本比反复点击更划算',
  ],
  synthesize: async (params, context) => {
    const endpoint = context.fields?.endpoint?.trim() || DEFAULT_SOVITS_BASE;

    // 模型 id 直接映射版本号，让「选择模型」与「切换权重」是同一件事。
    //
    // 但 model id 用的是**小写**（gpt-sovits-v2proplus），而服务端的版本名是
    // **混合大小写**（v2ProPlus）—— 直接把后缀当版本名传下去，服务端会报
    // 「未知模型版本：v2proplus」。所以这里做大小写不敏感的匹配。
    const VERSION_ALIASES = ['v1', 'v2', 'v2Pro', 'v2ProPlus', 'v3', 'v4'];
    const versionFromModel = params.model.replace(/^gpt-sovits-/, '');
    const matched = VERSION_ALIASES.find(
      (item) => item.toLowerCase() === versionFromModel.toLowerCase(),
    );

    // 页面上选的版本（fields.version）永远优先 —— 它才是用户此刻真正的意图；
    // model id 只是「没选时的兜底」。
    const version = context.fields?.version?.trim() || undefined;
    const resolvedVersion = version ?? matched;

    const textLang = params.language?.trim() || undefined;

    // 音色只认 Provider 字段（来自设置页的默认值，或合成页当场的选择）。
    // 这里刻意**忽略** `params.voice`：在 MiMo 链路里它是预置音色名（如「冰糖」），
    // 传给 GPT-SoVITS 只会变成一次「音色不存在」的误会。
    const payload = {
      mode: params.mode === 'clone' ? ('clone' as const) : ('preset' as const),
      text: params.text,
      voice: context.fields?.voice?.trim() || undefined,
      ref_audio_path: context.fields?.ref_audio_path?.trim() || undefined,
      prompt_text: context.fields?.prompt_text?.trim() || undefined,
      prompt_lang: context.fields?.prompt_lang?.trim() || undefined,
      text_lang: textLang,
      version: resolvedVersion,
      gpt: context.fields?.gpt?.trim() || undefined,
      sovits: context.fields?.sovits?.trim() || undefined,
      inline_base64: true,
      params: {
        text_split_method: context.fields?.text_split_method?.trim() || undefined,
        speed_factor: context.fields?.speed_factor
          ? Number(context.fields.speed_factor)
          : undefined,
      },
    };

    const result = await sovitsApi.synthesize(payload, endpoint);

    // 单段返回（官方内部已按切分方式分段并拼成一个完整音频）
    const audio = result.audio;
    if (!audio) {
      throw new RequestError(502, {
        code: 'SOVITS_NO_AUDIO',
        message: '本地服务未返回音频数据',
        retryable: true,
      });
    }

    return {
      segments: [
        {
          index: 0,
          audio,
          bytes: result.bytes,
          durationSec: result.duration_s,
          text: result.text,
        },
      ],
      mimeType: result.mime_type || 'audio/wav',
      format: 'wav',
      model: result.sovits_model ?? params.model,
      bytes: result.bytes,
      durationSec: result.duration_s,
      segmented: false,
      segmentCount: 1,
      mode: params.mode,
      text: result.text,
    } satisfies SynthesizeResponse;
  },
};
