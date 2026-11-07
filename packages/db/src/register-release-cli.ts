import { runRegisterReleaseStandalone } from "./register-release.js";

/** Parses `--key value` pairs from argv — the release CI workflow (and a human
 * widening a rollout later) calls this directly, there's no Super Admin UI for it
 * yet (that's P3-39). */
function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`register-release: expected "--key value" pairs, got "${key ?? ""} ${value ?? ""}"`);
    }
    args[key.slice(2)] = value;
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

for (const required of ["platform", "version", "url", "signature"]) {
  if (!args[required]) {
    console.error(`register-release: missing required --${required}`);
    process.exit(1);
  }
}

runRegisterReleaseStandalone(
  {
    platform: args["platform"]!,
    version: args["version"]!,
    url: args["url"]!,
    signature: args["signature"]!,
    notes: args["notes"] ?? null,
    rolloutPercentage: args["rollout"] ? Number(args["rollout"]) : 10,
  },
  process.env.DATABASE_URL,
)
  .then((result) => {
    console.log(`Registered ${result.platform} ${result.version} at ${result.rolloutPercentage}% rollout`);
  })
  .catch((error: unknown) => {
    console.error("register-release failed", error);
    process.exit(1);
  });
