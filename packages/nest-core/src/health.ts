import { Controller, Get } from "@nestjs/common";

export interface HealthStatus {
  status: "ok";
  uptimeSeconds: number;
  timestamp: string;
}

function currentStatus(): HealthStatus {
  return {
    status: "ok",
    uptimeSeconds: process.uptime(),
    timestamp: new Date().toISOString(),
  };
}

@Controller("health")
export class HealthController {
  /** Liveness: the process is up and able to respond. */
  @Get()
  liveness(): HealthStatus {
    return currentStatus();
  }

  /** Readiness: same as liveness for now; extend with dependency checks once each app has a DB/queue client. */
  @Get("ready")
  readiness(): HealthStatus {
    return currentStatus();
  }
}
