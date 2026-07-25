import pino from "pino";
import { env } from "../config/env.js";

/**
 * Logger estruturado. Em produção emite JSON (fácil de ingerir em Datadog,
 * Loki, CloudWatch, etc.). Em desenvolvimento usa pino-pretty (legível).
 */
export const logger = pino({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  transport:
    env.NODE_ENV !== "production"
      ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } }
      : undefined,
});
