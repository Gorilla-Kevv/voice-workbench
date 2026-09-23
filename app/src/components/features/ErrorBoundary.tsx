import { Component, type ErrorInfo, type ReactNode } from 'react';
import { RefreshCw, RotateCcw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';

/**
 * 与 `lib/constants` 的 `STORAGE_KEYS` / `lib/sovits` 的 `SOVITS_URL_STORAGE_KEY` 保持一致。
 *
 * 这里刻意内联而不是 import：错误边界要能在「什么都坏了」的时候工作，
 * 所以除了 React 与基础 UI 组件，它不应该依赖任何业务模块 ——
 * 否则一旦依赖链本身出问题，兜底就跟着一起失效。
 */
const SETTINGS_KEY = 'mimo-voice:settings';
const SOVITS_URL_KEY = 'mimo-voice:sovits-url';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 渲染期错误的兜底界面。
 *
 * React 在渲染期抛错时会卸载整棵树，用户看到的是**纯白页面** ——
 * 没有错误信息、没有重试入口，只能靠猜。这个边界把错误本身渲染出来，
 * 把「白屏」变成一个可以自助解决的问题。
 *
 * 能捕获：渲染期、生命周期、子组件构造函数里的异常。
 * 捕获不到：事件处理器与异步代码里的异常（那些通过 toast 与 ResultPanel 呈现）。
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 保留完整信息到控制台：界面上的堆栈是给用户看的，这里的才是给排查用的
    console.error('[AppErrorBoundary] 渲染期异常', error, info.componentStack);
  }

  /** 清掉本地配置再重载 —— 覆盖「损坏的持久化数据把页面顶死」这一类故障 */
  private resetLocalState = (): void => {
    try {
      localStorage.removeItem(SETTINGS_KEY);
      localStorage.removeItem(SOVITS_URL_KEY);
    } catch {
      // 隐私模式下不可写，清不掉也无妨
    }
    window.location.reload();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <div className="w-full max-w-2xl space-y-4 rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-destructive/10">
              <TriangleAlert className="size-4 text-destructive" />
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold">页面渲染出错</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                这是界面自身的异常，与本地的模型服务无关（模型服务仍在运行）。
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">错误信息</p>
            <pre className="scrollbar-thin max-h-32 overflow-auto rounded-lg bg-muted/60 p-3 text-xs leading-relaxed">
              {error.name}: {error.message}
            </pre>
            {error.stack ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                  展开调用栈
                </summary>
                <pre className="scrollbar-thin mt-2 max-h-64 overflow-auto rounded-lg bg-muted/40 p-3 leading-relaxed">
                  {error.stack}
                </pre>
              </details>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => window.location.reload()}>
              <RefreshCw className="mr-1.5 size-3.5" />
              重新加载
            </Button>
            <Button size="sm" variant="outline" onClick={this.resetLocalState}>
              <RotateCcw className="mr-1.5 size-3.5" />
              重置本地配置后重载
            </Button>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            重新加载无效时，多半是本地保存的配置有问题，用「重置本地配置后重载」即可
            （只会清掉设置项，历史记录不受影响）。把上面的错误信息与浏览器控制台的
            完整日志一起反馈，能更快定位。
          </p>
        </div>
      </div>
    );
  }
}
