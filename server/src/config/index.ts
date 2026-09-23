import 'dotenv/config';

/** MiMo 官方接口地址（OpenAI 兼容协议） */
const OFFICIAL_BASE_URL = 'https://api.xiaomimimo.com/v1';

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

export const config = {
  env: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 8787),
  /** 监听地址。本地工具默认只监听环回地址；局域网共享再改成 0.0.0.0 */
  host: process.env.HOST?.trim() || '127.0.0.1',

  /** 服务端托管的 API Key。未配置时前端需由用户自带 Key（BYOK）。 */
  mimoApiKey: process.env.MIMO_API_KEY?.trim() || '',

  /** 允许通过环境变量切换到 Token Plan / 批量推理等其它入口 */
  mimoBaseUrl: (process.env.MIMO_BASE_URL?.trim() || OFFICIAL_BASE_URL).replace(/\/+$/, ''),

  /** 单次上游请求超时（TTS 推理较慢，默认 120s） */
  upstreamTimeoutMs: num(process.env.UPSTREAM_TIMEOUT_MS, 120_000),

  /** 上游失败重试次数（仅针对 429 / 5xx / 网络错误） */
  upstreamRetries: num(process.env.UPSTREAM_RETRIES, 2),

  /** 请求体上限，克隆样本最大 10MB，base64 后约 13.4MB */
  jsonBodyLimit: process.env.JSON_BODY_LIMIT?.trim() || '20mb',

  /** 单条合成文本长度上限（字符） */
  maxTextLength: num(process.env.MAX_TEXT_LENGTH, 3000),

  /** 克隆样本上限（字节），官方限制 10MB */
  maxSampleBytes: num(process.env.MAX_SAMPLE_BYTES, 10 * 1024 * 1024),

  /** 站点级限流：窗口内每 IP 的请求次数 */
  rateLimit: {
    windowMs: num(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    /** 合成类接口（消耗额度，限制更严） */
    synthMax: num(process.env.RATE_LIMIT_SYNTH_MAX, 20),
    /** 普通查询类接口 */
    generalMax: num(process.env.RATE_LIMIT_GENERAL_MAX, 120),
  },

  /** 允许的跨域来源，逗号分隔；* 表示全部 */
  corsOrigin: process.env.CORS_ORIGIN?.trim() || '*',

  /** 前端构建产物目录（生产环境静态托管） */
  staticDir: process.env.STATIC_DIR?.trim() || '',

  /** 是否在日志中输出上游请求摘要 */
  verboseLog: process.env.VERBOSE_LOG === 'true',

  /**
   * GPT-SoVITS 本地服务（trainer/）的接入配置。
   *
   * 本项目定位为**本地部署**，默认由启动编排器（`npm run dev` 里的 sovits 任务）
   * 负责把 Python 服务拉起来，网关只做探活与转发。
   *
   * 为什么不交给网关托管（这是实测出来的）：
   * 开发时网关由 `tsx watch` 托管，改一次后端代码就会重启一次网关；
   * 而网关退出时会回收自己拉起的 Python 服务 —— 结果是改一行代码就要
   * 等 40 秒重新加载模型。把 Python 的生命周期交给 concurrently，
   * 它与 tsx watch 互不影响，Ctrl+C 时又能被一起回收，不留孤儿进程。
   *
   * 单独跑 `npm run dev:server` 时把它设为 true，网关就会自己拉起。
   */
  sovits: {
    /** GPT-SoVITS 本地服务地址 */
    baseUrl: (process.env.SOVITS_URL?.trim() || 'http://127.0.0.1:9881').replace(/\/+$/, ''),
    /** 是否由本进程托管 Python 服务的生命周期 */
    autostart: bool(process.env.SOVITS_AUTOSTART, false),
    /** GPT-SoVITS 根目录；留空则由 Python 侧自动搜索 */
    home: process.env.GPT_SOVITS_HOME?.trim() || '',
    /** GPT-SoVITS 自带解释器；留空则自动探测 runtime/python */
    python: process.env.SOVITS_PYTHON?.trim() || '',
    /** 等待 Python 服务就绪的上限（毫秒）。首次冷启动要 import torch，留足余量 */
    readyTimeoutMs: num(process.env.SOVITS_READY_TIMEOUT_MS, 300_000),
    /** 代理请求超时（毫秒）。合成与训练都是长任务 */
    proxyTimeoutMs: num(process.env.SOVITS_PROXY_TIMEOUT_MS, 0),
  },
} as const;

export const isProduction = config.env === 'production';
