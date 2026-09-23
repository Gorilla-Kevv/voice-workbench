import type { ApiErrorBody } from '@/types';

/**
 * 携带错误码的请求异常。
 * 独立成文件以避免 api.ts 与 direct-api.ts 之间形成循环依赖。
 *
 * `hint` 刻意保留并透出：本地服务的失败绝大多数是「环境/参数」问题，
 * 服务端给出的「下一步该做什么」往往比错误本身更有用 ——
 * 把它折叠掉，用户就只剩下「请求失败」这一句无从下手的信息。
 */
export class RequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly retryAfterSec?: number;
  /** 服务端给出的修复建议（可选） */
  readonly hint?: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = 'RequestError';
    this.status = status;
    this.code = body.code;
    this.retryable = body.retryable ?? false;
    this.retryAfterSec = body.retryAfterSec;
    this.hint = body.hint;
    this.details = body.details;
  }

  /** 错误 + 建议的合并文本，适合直接放进 toast 的描述里 */
  get fullMessage(): string {
    return this.hint ? `${this.message}\n${this.hint}` : this.message;
  }
}
