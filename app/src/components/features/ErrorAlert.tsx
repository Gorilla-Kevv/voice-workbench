import { AlertTriangle, RefreshCw, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { RequestError } from '@/lib/api';

interface ErrorAlertProps {
  error: RequestError | null;
  onRetry?: () => void;
  onDismiss?: () => void;
}

/** 错误提示条：按错误类型给出对应建议，可重试错误展示重试入口 */
export function ErrorAlert({ error, onRetry, onDismiss }: ErrorAlertProps) {
  if (!error) return null;

  const hints: Record<string, string> = {
    MISSING_API_KEY: '前往「设置」填写你的 MiMo API Key，或联系站点管理员配置服务端密钥',
    UNAUTHORIZED: '密钥可能已失效，请到控制台重新生成后更新「设置」',
    RATE_LIMITED: '站点或官方限流已触发，请稍等片刻再试',
    TEXT_TOO_LONG: '可开启「长文本自动分段」由服务端自动切分后合成',
    SAMPLE_TOO_LARGE: '建议裁剪到 30 秒以内，或压缩为 128kbps 的 mp3',
    SAMPLE_FORMAT_UNSUPPORTED: '目前仅支持 mp3 与 wav 两种格式',
    NETWORK_ERROR: '请确认后端服务已启动，或检查网络连接',
    CLIENT_TIMEOUT: '长文本合成耗时较长，可缩短文本或开启自动分段',
    UPSTREAM_TIMEOUT: 'MiMo 侧响应超时，稍后重试通常可恢复',
  };

  const hint = hints[error.code];

  return (
    <Alert variant="destructive" className="relative">
      <AlertTriangle className="size-4" />
      <AlertTitle className="pr-16">合成失败</AlertTitle>
      <AlertDescription>
        <p>{error.message}</p>
        {hint ? <p className="mt-1 text-xs opacity-90">{hint}</p> : null}
        {error.retryAfterSec ? (
          <p className="mt-1 text-xs opacity-90">建议 {error.retryAfterSec} 秒后重试</p>
        ) : null}
        {onRetry && error.retryable ? (
          <Button size="sm" variant="secondary" className="mt-3 h-7" onClick={onRetry}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        ) : null}
      </AlertDescription>
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="关闭错误提示"
          className="absolute right-3 top-3 rounded-md p-1 opacity-70 transition hover:bg-destructive/10 hover:opacity-100"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </Alert>
  );
}
