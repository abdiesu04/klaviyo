// =============================================================================
// Klaviyo Flow Builder — Logger
// =============================================================================

import * as winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp: ts, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${ts} [${level}] ${message}${metaStr}`;
});

let loggerInstance: winston.Logger | null = null;

/**
 * Create or return the singleton logger.
 */
export function createLogger(level: string = 'info'): winston.Logger {
  if (loggerInstance) return loggerInstance;

  loggerInstance = winston.createLogger({
    level,
    format: combine(
      timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
      logFormat,
    ),
    transports: [
      new winston.transports.Console({
        format: combine(
          colorize(),
          timestamp({ format: 'HH:mm:ss' }),
          logFormat,
        ),
      }),
      new winston.transports.File({
        filename: 'klaviyo-flow-builder.log',
        maxsize: 5 * 1024 * 1024, // 5MB
        maxFiles: 3,
      }),
    ],
  });

  return loggerInstance;
}

/**
 * Get the existing logger instance.
 */
export function getLogger(): winston.Logger {
  if (!loggerInstance) {
    return createLogger();
  }
  return loggerInstance;
}
