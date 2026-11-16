import { z } from "zod";

export const UploadedImageSchema = z.object({
  url: z.string().url(),
});
export type UploadedImage = z.infer<typeof UploadedImageSchema>;
