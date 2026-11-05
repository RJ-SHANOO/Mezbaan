import { Controller, Get, Res } from "@nestjs/common";
import type { FastifyInstance, FastifyReply } from "fastify";
import { Registry, Histogram, collectDefaultMetrics } from "prom-client";

export const metricsRegistry = new Registry();

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  registers: [metricsRegistry],
});

let defaultMetricsStarted = false;

/** Safe to call more than once; only wires up process-level metrics the first time. */
export function ensureDefaultMetrics(serviceName: string): void {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  metricsRegistry.setDefaultLabels({ service: serviceName });
  collectDefaultMetrics({ register: metricsRegistry });
}

/** Records request duration per route so a slow/failing endpoint shows up in Prometheus, not just logs. */
export function registerMetricsHooks(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", (request, reply, done) => {
    const route = request.routeOptions?.url ?? request.url;
    httpRequestDuration.observe(
      { method: request.method, route, status_code: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
    done();
  });
}

@Controller("metrics")
export class MetricsController {
  @Get()
  async metrics(@Res() reply: FastifyReply): Promise<void> {
    reply.header("Content-Type", metricsRegistry.contentType);
    reply.send(await metricsRegistry.metrics());
  }
}
