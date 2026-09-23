import { gptSovitsProvider } from './gpt-sovits';
import { mimoProvider } from './mimo';
import { selfHostedProvider } from './selfhosted';
import { SUPPORTED_LANGUAGES, type TtsProvider } from './types';

/** 全部可用 Provider。新增模型时只需在此注册。 */
export const PROVIDERS: TtsProvider[] = [mimoProvider, gptSovitsProvider, selfHostedProvider];

/** 默认 Provider：保持为小米 MiMo，既有行为不变 */
export const DEFAULT_PROVIDER_ID = 'mimo';

export function getProvider(id: string | undefined): TtsProvider {
  return PROVIDERS.find((provider) => provider.id === id) ?? mimoProvider;
}

/** 语言代码转显示名 */
export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES.find((item) => item.code === code)?.label ?? code;
}

/**
 * 计算某 Provider 实际支持的语言。
 * 自托管 Provider 的语言由用户在配置中声明，需并入计算。
 */
export function resolveLanguages(provider: TtsProvider, fields?: Record<string, string>): string[] {
  const declared = (fields?.languages ?? '')
    .split(/[,，\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);

  const fromModels = provider.models.flatMap((model) => model.languages);
  return Array.from(new Set([...provider.languages, ...fromModels, ...declared]));
}

/** 是否支持指定语言 */
export function supportsLanguage(
  provider: TtsProvider,
  language: string,
  fields?: Record<string, string>,
): boolean {
  return resolveLanguages(provider, fields).includes(language);
}

/**
 * 按「需要合成的语言」推荐 Provider。
 *
 * 存在的意义很实际：MiMo 官方未开放日语与韩语，用户拿中文音色硬合成日语
 * 只会得到奇怪的口音。这里让界面能主动提示「换 GPT-SoVITS」。
 */
export function recommendProvider(language: string, currentId: string): TtsProvider | null {
  const current = getProvider(currentId);
  if (supportsLanguage(current, language)) return null;
  return PROVIDERS.find((provider) => provider.id !== current.id && supportsLanguage(provider, language)) ?? null;
}
