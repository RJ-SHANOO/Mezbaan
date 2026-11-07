import { z } from "zod";

/** The flat shape Tauri's updater plugin expects from a dynamic update-check
 * endpoint (no `platforms` wrapper — the endpoint already resolves target/arch
 * from the request URL, see ReleasesController). */
export const UpdateManifestSchema = z.object({
  version: z.string().min(1),
  notes: z.string().nullable(),
  pub_date: z.string(),
  url: z.string().min(1),
  signature: z.string().min(1),
});
export type UpdateManifest = z.infer<typeof UpdateManifestSchema>;
