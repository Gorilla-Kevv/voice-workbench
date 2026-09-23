/** 业务错误码 */
export type AppErrorCode =
  | 'INVALID_REQUEST'
  | 'TEXT_TOO_LONG'
  | 'TEXT_EMPTY'
  | 'VOICE_REQUIRED'
  | 'VOICE_DESCRIPTION_REQUIRED'
  | 'SAMPLE_REQUIRED'
  | 'SAMPLE_TOO_LARGE'
  | 'SAMPLE_FORMAT_UNSUPPORTED'
  | 'MISSING_API_KEY'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_UNAVAILABLE'
  | 'UPSTREAM_TIMEOUT'
  | 'NO_AUDIO_IN_RESPONSE'
  | 'INTERNAL_ERROR';

/** 统一的应用异常，携带 HTTP 状态码与面向用户的中文提示 */
export class AppError extends Error {
  readonly status: number;
  readonly code: AppErrorCode;
  /** 是否可安全重试（前端据此决定是否显示「重试」按钮） */
  readonly retryable: boolean;
  readonly details?: unknown;

  constructor(
    status: number,
    code: AppErrorCode,
    message: string,
    options: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/** 上游 HTTP 状态码 → 用户可读的中文提示与重试建议 */
const UPSTREAM_STATUS_MAP: Record<number, { code: AppErrorCode; message: string; retryable: boolean }> = {
  400: { code: 'INVALID_REQUEST', message: '请求参数有误，请检查文本内容、音色或音频样本格式', retryable: false },
  401: { code: 'UNAUTHORIZED', message: 'API Key 无效或已过期，请到「设置」中更换密钥', retryable: false },
  403: { code: 'FORBIDDEN', message: '没有访问该模型的权限，请确认账号已开通对应服务', retryable: false },
  404: { code: 'NOT_FOUND', message: '接口地址或模型不存在，请确认模型名称与 Base URL', retryable: false },
  413: { code: 'PAYLOAD_TOO_LARGE', message: '音频样本或请求体过大，请压缩后重试（样本需小于 10MB）', retryable: false },
  422: { code: 'INVALID_REQUEST', message: '参数校验未通过，请检查文本与音色描述是否符合要求', retryable: false },
  429: { code: 'RATE_LIMITED', message: '调用过于频繁，已触发官方限流，请等待几秒后重试', retryable: true },
  500: { code: 'UPSTREAM_ERROR', message: 'MiMo 服务端出现异常，请稍后重试', retryable: true },
  502: { code: 'UPSTREAM_UNAVAILABLE', message: '上游网关异常，请稍后重试', retryable: true },
  503: { code: 'UPSTREAM_UNAVAILABLE', message: 'MiMo 服务暂时不可用，请稍后重试', retryable: true },
  504: { code: 'UPSTREAM_TIMEOUT', message: '上游服务响应超时，请稍后重试或缩短文本长度', retryable: true },
};

/** 将上游返回的 HTTP 状态码转换为 AppError */
export function fromUpstreamStatus(status: number, rawMessage?: string, details?: unknown): AppError {
  const mapped = UPSTREAM_STATUS_MAP[status];
  if (mapped) {
    return new AppError(status, mapped.code, mapped.message, { retryable: mapped.retryable, details: details ?? rawMessage });
  }
  if (status >= 500) {
    return new AppError(status, 'UPSTREAM_ERROR', 'MiMo 服务端异常，请稍后重试', { retryable: true, details });
  }
  return new AppError(
    status || 502,
    'UPSTREAM_ERROR',
    rawMessage ? `调用失败：${rawMessage}` : '调用 MiMo 接口失败，请稍后重试',
    { details },
  );
}
