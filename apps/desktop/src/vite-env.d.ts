/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_POS_URL?: string;
  /** Ed25519 SPKI PEM — build-time config, never fetched live from api-pos
   * itself (see snapshot_sync.rs for why that distinction matters). */
  readonly VITE_SYNC_PUBLIC_KEY_PEM?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
