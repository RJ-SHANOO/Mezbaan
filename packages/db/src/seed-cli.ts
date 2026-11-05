import { runSeedStandalone } from "./seed.js";

runSeedStandalone(process.env.DATABASE_URL)
  .then((result) => {
    console.log(
      `Seeded ${result.roleCount} roles, ${result.permissionCount} permissions, ${result.rolePermissionCount} role-permission links`,
    );
  })
  .catch((error: unknown) => {
    console.error("Seed failed", error);
    process.exit(1);
  });
