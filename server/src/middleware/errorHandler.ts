import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    retryable: boolean;
    details?: unknown;
  };
}

/** 404 兜底 */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: `接口 ${req.method} ${req.path} 不存在`,
      retryable: false,
    },
  } satisfies ApiErrorBody);
}

/** 统一异常出口：把任何异常转换为结构化 JSON */
export function errorHandler(error: unknown, req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof AppError) {
    if (error.status >= 500) {
      logger.warn('业务异常', { path: req.path, code: error.code, status: error.status, message: error.message });
    }
    res.status(error.status).json({
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        details: error.details,
      },
    } satisfies ApiErrorBody);
    return;
  }

  // express.json 在请求体非法或超大时抛出的错误
  const maybeBodyError = error as { type?: string; status?: number; message?: string };
  if (maybeBodyError?.type === 'entity.too.large') {
    res.status(413).json({
      ok: false,
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: '请求体过大，音频样本请控制在 10MB 以内',
        retryable: false,
      },
    } satisfies ApiErrorBody);
    return;
  }
  if (maybeBodyError?.type === 'entity.parse.failed') {
    res.status(400).json({
      ok: false,
      error: { code: 'INVALID_REQUEST', message: '请求体不是合法的 JSON', retryable: false },
    } satisfies ApiErrorBody);
    return;
  }

  logger.error('未处理异常', {
    path: req.path,
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  res.status(500).json({
    ok: false,
    error: {
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误，请稍后重试',
      retryable: true,
    },
  } satisfies ApiErrorBody);
}
