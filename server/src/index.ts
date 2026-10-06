import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import { config, isProduction } from './config/index.js';
import { logger } from './lib/logger.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { apiRouter } from './routes/index.js';
import { indexttsProxyRouter } from './routes/indextts.js';
import { neteaseProxyRouter } from './routes/netease.js';
import { createRuntimeServiceRouter } from './routes/runtimeService.js';
import { indexttsSupervisor, neteaseSupervisor, runtimeSupervisors } from './services/runtime.js';
import { sovitsProxyRouter, sovitsServiceRouter } from './routes/sovits.js';
import { preloadService } from './services/preload.js';
import { sovitsSupervisor } from './services/sovits.js';

const app = express();

// 本地网关场景下正确解析客户端 IP，供限流使用
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  cors({
    origin: config.corsOrigin === '*' ? true : config.corsOrigin.split(',').map((item) => item.trim()),
    credentials: false,
  }),
);

// GPT-SoVITS 代理必须挂在 express.json() **之前**：
// 它需要原始请求流（音频上传是 multipart，流式合成是 NDJSON），
// 一旦被 body-parser 消费过，这两类请求就透传不出去了。
// 网易模块代理同理（NDJSON 流式转写 + multipart 音频上传），必须一起挂在这里。
// IndexTTS 代理也一样（multipart 音频上传）。
// GPT-SoVITS 服务的启停要在代理**之前**注册，否则会被代理的通配规则吃掉。
// 网易 / IndexTTS 的启停接口同理，也挂在各自代理之前。
// 这条路由自己开 express.json()，所以不受「代理必须早于 body-parser」的约束。
app.use('/api/sovits/service', sovitsServiceRouter);
app.use('/api/netease/service', createRuntimeServiceRouter(neteaseSupervisor, '网易 Confucius4-TTS'));
app.use('/api/indextts/service', createRuntimeServiceRouter(indexttsSupervisor, 'IndexTTS'));
app.use('/api/sovits', sovitsProxyRouter);
app.use('/api/netease', neteaseProxyRouter);
app.use('/api/indextts', indexttsProxyRouter);

// 克隆样本经 base64 传输，需要放宽请求体上限
app.use(express.json({ limit: config.jsonBodyLimit }));

// 简易访问日志
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    if (req.path === '/api/health') return;
    logger.info('请求', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      ms: Date.now() - startedAt,
    });
  });
  next();
});

app.use('/api', apiRouter);

/**
 * 每 30 秒探一次 GPT-SoVITS 本地服务。
 *
 * 没有这个定时器，`/api/health` 里的 `reachable` 会**停在最后一次探活的结果** ——
 * 服务被我们关掉（或自己崩了）之后，侧栏状态卡还显示「已连接」，
 * 用户点进去才发现用不了。本地环回的一次 GET 很便宜，换来的是状态不再骗人。
 */
const probeTimer = setInterval(() => {
  void sovitsSupervisor.probe().catch(() => undefined);
}, 30_000);
probeTimer.unref?.();

// 生产环境托管前端构建产物，实现单服务部署
const staticDir = resolveStaticDir();
if (staticDir) {
  app.use(express.static(staticDir, { maxAge: '1h', index: false }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(staticDir, 'index.html'));
  });
  logger.info('已启用前端静态托管', { staticDir });
}

app.use(notFoundHandler);
app.use(errorHandler);

/** 依次尝试常见的前端产物路径 */
function resolveStaticDir(): string | null {
  const candidates = [
    config.staticDir,
    path.resolve(process.cwd(), 'public'),
    path.resolve(process.cwd(), '../app/dist'),
    path.resolve(process.cwd(), 'app/dist'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
    } catch {
      // 忽略不可访问的路径
    }
  }
  return null;
}

const server = app.listen(config.port, config.host, () => {
  logger.info('本地语音工作台已启动', {
    url: `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}`,
    env: config.env,
    production: isProduction,
  });
  logger.info('MiMo 云端模型', {
    baseUrl: config.mimoBaseUrl,
    hasServerKey: Boolean(config.mimoApiKey),
  });
  if (!config.mimoApiKey) {
    logger.warn('未检测到服务端 MIMO_API_KEY，使用 MiMo 时需在页面「设置」中填写密钥');
  }

  // 后台拉起 GPT-SoVITS 本地服务。不 await：Node 侧要先把页面服务起来，
  // 用户至少能立刻看到界面与「正在启动本地模型服务」的状态。
  //
  // 就绪叙事集中在 announceReady() 里：这里是「复用外部实例 / 新拉起 / 已就绪」
  // 三条路径唯一的汇聚点，放在这里才不会出现重复或漏报。
  void sovitsSupervisor
    .ensureStarted()
    .then(() => sovitsSupervisor.announceReady())
    .catch((error: Error) => logger.error('启动 GPT-SoVITS 本地服务异常', { message: error.message }));

  // 网易 / IndexTTS 同理：设置里开着（或网易默认开）就后台拉起；
  // 已被外部终端起了的会直接复用，不会重复占端口。
  for (const supervisor of runtimeSupervisors) {
    void supervisor
      .ensureStarted()
      .catch((error: Error) => logger.error('运行时服务启动异常', { message: error.message }));
  }

  // 按用户偏好预加载一个模型（'ask' 表示每次启动由界面问他，这里不动）。
  // 同样不 await —— 加载要数十秒，界面必须先看得到。
  const preference = preloadService.preference().model;
  if (preference !== 'ask' && preference !== 'none') {
    logger.info('按偏好预加载模型', { model: preference });
    void preloadService.preload(preference).catch((error: Error) => {
      logger.error('启动预加载异常', { model: preference, message: error.message });
    });
  }
});

let shuttingDown = false;

// 优雅退出：先停前端服务，再收掉由我们拉起的 Python 子进程
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭服务`);

    server.close(() => {
      void Promise.allSettled([
        sovitsSupervisor.stop(),
        ...runtimeSupervisors.map((s) => s.shutdown()),
      ]).finally(() => process.exit(0));
    });
    // 兜底：8 秒内没退干净就强退，但先把子进程带走
    setTimeout(() => {
      void Promise.allSettled([
        sovitsSupervisor.stop(),
        ...runtimeSupervisors.map((s) => s.shutdown()),
      ]).finally(() => process.exit(0));
    }, 8_000).unref();
  });
}

// tsx watch 热重载或异常退出时，同样要收掉子进程，
// 否则下一次启动会因为「端口被占用 / 显存已被吃掉」而失败。
process.on('exit', () => {
  const status = sovitsSupervisor.status();
  if (status.managed && status.pid) {
    try {
      process.kill(status.pid);
    } catch {
      // 已退出
    }
  }
  for (const supervisor of runtimeSupervisors) {
    const runtimeStatus = supervisor.status();
    if (runtimeStatus.managed && runtimeStatus.pid) {
      try {
        process.kill(runtimeStatus.pid);
      } catch {
        // 已退出
      }
    }
  }
});
