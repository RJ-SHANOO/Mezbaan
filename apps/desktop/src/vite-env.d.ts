/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_POS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
