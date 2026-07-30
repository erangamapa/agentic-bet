import pino from 'pino';
import { env, isProduction } from '../config/env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: 'agentic-bet' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-api-key"]',
      'privateKey',
      'OPERATOR_PRIVATE_KEY',
      '*.privateKey',
    ],
    censor: '[redacted]',
  },
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
        },
      }),
});

export type Logger = typeof logger;

export const childLogger = (bindings: Record<string, unknown>) => logger.child(bindings);
