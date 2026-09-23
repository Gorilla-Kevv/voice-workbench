/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 接口模式：proxy=经后端代理（默认）；direct=浏览器直连 MiMo */
  readonly VITE_API_MODE?: 'proxy' | 'direct';
  /** direct 模式下的 MiMo 接口地址 */
  readonly VITE_MIMO_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
