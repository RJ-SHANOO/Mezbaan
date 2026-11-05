import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

if (existsSync("drizzle.config.ts")) {
  execSync("pnpm exec drizzle-kit check", { stdio: "inherit" });
} else {
  console.log("packages/db: no drizzle.config.ts yet — skipping migration check");
}
