import winston from 'winston';
import path from 'path';

const LOG_DIR = path.resolve(process.cwd(), 'logs');

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message, module: mod, ...meta }) => {
    const moduleTag = mod ? `[${mod}]` : '';
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level.toUpperCase()}] ${moduleTag} ${message}${metaStr}`;
  })
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        logFormat
      ),
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(LOG_DIR, 'bot.log'),
    }),
  ],
});

/**
 * Creates a child logger tagged with a module name
 */
export function createModuleLogger(moduleName: string): winston.Logger {
  return logger.child({ module: moduleName });
}

export default logger;
