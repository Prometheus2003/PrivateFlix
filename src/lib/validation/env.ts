import "server-only";
import { parseEnv, type Env } from "./env-schema";
let cached: Env | undefined;
export function getEnv(): Env {
  return (cached ??= parseEnv(process.env));
}
