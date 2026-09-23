import rateLimit, { type Options } from 'express-rate-limit';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config/index.js';

/** 统一的 429 响应体，前端据此展示限流提示与倒计时 */
function limitHandler(_req: Request, res: Response, _next: NextFunction, options: Options): void {
  const retryAfterSec = Math.ceil((options.windowMs ?? 60_000) / 1000);
  res.status(429).json({
    ok: false,
    error: {
      code: 'RATE_LIMITED',
      message: '请求过于频繁，站点限流保护已生效，请稍后再试',
      retryable: true,
      retryAfterSec,
    },
  });
}

const baseOptions: Partial<Options> = {
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
  // 反向代理（Nginx / 云托管）下正确识别客户端 IP
  validate: { trustProxy: false },
};

/**
 * 合成类接口限流：直接消耗 MiMo 额度，限制更严格。
 */
export const synthLimiter = rateLimit({
  ...baseOptions,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.synthMax,
});

/**
 * 普通接口限流：健康检查、音色列表、Key 校验等。
 */
export const generalLimiter = rateLimit({
  ...baseOptions,
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.generalMax,
});
