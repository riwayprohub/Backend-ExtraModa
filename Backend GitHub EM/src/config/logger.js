/**
 * Logger sin dependencias: timestamps + nivel.
 * En producción emite JSON (una línea por evento) para ingestion por Loki/Datadog;
 * en desarrollo, texto legible con color.
 */
import { env } from './env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';

const minLevel = env.isProd ? LEVELS.info : LEVELS.debug;

function write(level, message, meta) {
  if (LEVELS[level] < minLevel) return;

  const time = new Date().toISOString();

  if (env.isProd) {
    process.stdout.write(
      `${JSON.stringify({ time, level, message, ...meta })}\n`
    );
    return;
  }

  const details = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  process.stdout.write(
    `${COLORS[level]}${time} ${level.toUpperCase().padEnd(5)}${RESET} ${message}${details}\n`
  );
}

export const logger = {
  debug: (message, meta) => write('debug', message, meta),
  info: (message, meta) => write('info', message, meta),
  warn: (message, meta) => write('warn', message, meta),
  error: (message, meta) => write('error', message, meta)
  // El logging HTTP lo hace morgan en app.js; aquí solo eventos de aplicación.
};