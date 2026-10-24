import { config } from '../config/index.js';

/**
 * 五个自有 Python 运行时的「身份表」：服务 id、基础地址、卸载端点的唯一事实源。
 *
 * 这份信息曾经散在三处 —— arbiter 的 ALL_SERVICES / RELEASE_ENDPOINTS、preload
 * 各模型自己的 release()、config 里各自的 baseUrl —— 新增一个运行时要改 N 个文件
 * 还容易漏（Irodori 接入时「运行时/仲裁器/预加载/资源预估四处记账」就是这么来的）。
 * 收敛之后：**加运行时 = config 里加 baseUrl + 这里加一行**，arbiter / preload 自动跟随。
 *
 * 硬边界不变：这张表只描述「本项目自己拉起的回环服务」。arbiter 发请求前
 * 仍会过它自己的回环校验（assertOwnService）；这里的辅助函数同样只朝 baseUrl 发卸载。
 */
export type RuntimeServiceId = 'sovits' | 'netease' | 'indextts' | 'irodori' | 'gsv5';

export interface RuntimeServiceSpec {
  id: RuntimeServiceId;
  /** 「卸载该服务全部常驻模型」的 POST 端点，按优先级排列；404 = 该端没有这个引擎，不算失败 */
  releasePaths: readonly string[];
}

export const RUNTIME_SERVICES: Record<RuntimeServiceId, RuntimeServiceSpec> = {
  // sovits：引擎注册表的 unload_all（SoVITS / RVC / SVC / ASR / UVR5）+ 官方管线本体
  sovits: { id: 'sovits', releasePaths: ['/v1/engines/unload', '/v1/pipeline/unload'] },
  netease: { id: 'netease', releasePaths: ['/v1/confucius/unload', '/v1/r2t2/unload'] },
  indextts: { id: 'indextts', releasePaths: ['/v1/unload'] },
  irodori: { id: 'irodori', releasePaths: ['/v1/unload'] },
  gsv5: { id: 'gsv5', releasePaths: ['/v1/unload'] },
};

export const RUNTIME_SERVICE_IDS = Object.keys(RUNTIME_SERVICES) as RuntimeServiceId[];

export function baseUrlOf(service: RuntimeServiceId): string {
  switch (service) {
    case 'netease':
      return config.netease.baseUrl;
    case 'indextts':
      return config.indextts.baseUrl;
    case 'irodori':
      return config.irodori.baseUrl;
    case 'gsv5':
      return config.gsv5.baseUrl;
    case 'sovits':
      return config.sovits.baseUrl;
  }
}

/**
 * 让位语义的卸载：把某服务上的常驻模型全部卸掉，**失败一律吞掉**。
 *
 * 给 preload 这类「让了位最好、让不了也不该阻塞」的调用方用；需要区分
 * 「没起（ECONNREFUSED）」与「真失败」并上报的（仲裁器）请自己按表发请求，
 * 别用这个 —— 吞错误正是它不适用于仲裁的原因。
 */
export async function releaseServiceModels(service: RuntimeServiceId, timeoutMs = 30_000): Promise<void> {
  const base = baseUrlOf(service);
  await Promise.all(
    RUNTIME_SERVICES[service].releasePaths.map(async (path) => {
      try {
        await fetch(`${base}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        // 服务没起 / 超时都等价于「没占着」；让位失败不阻塞预加载
      }
    }),
  );
}
