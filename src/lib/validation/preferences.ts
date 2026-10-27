import { z } from "zod";
export const preferencesSchema = z
  .object({
    theme: z.enum(["dark", "light"]).default("dark"),
    playbackSpeed: z
      .union([
        z.literal(0.5),
        z.literal(0.75),
        z.literal(1),
        z.literal(1.25),
        z.literal(1.5),
        z.literal(1.75),
        z.literal(2),
      ])
      .default(1),
    autoplay: z.boolean().default(false),
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;
export const defaultPreferences: Preferences = {
  theme: "dark",
  playbackSpeed: 1,
  autoplay: false,
};
