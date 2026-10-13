import { PrismaClient } from '@prisma/client';
import { env } from './env.js';
import { logger } from './logger.js';

/**
 * Patrón Singleton con cache en globalThis.
 *
 * Sin esto, cada recarga de nodemon crea un PrismaClient nuevo y MySQL agota
 * el límite de conexiones con procesos que ya están muertos.
 */
const globalForPrisma = globalThis;

/**
 * 'query' satura la consola en cada endpoint, así que va opt-in con LOG_QUERIES=true
 * (útil al depurar N+1 o revisar los SQL que genera el repository).
 */
const logLevels = env.LOG_QUERIES ? ['query', 'warn', 'error'] : ['warn', 'error'];

export const prisma =
  globalForPrisma.__extramodaPrisma ??
  new PrismaClient({ log: logLevels });

if (!env.isProd) globalForPrisma.__extramodaPrisma = prisma;

/** Comprobación de conectividad: úsala en GET /api/v1/health */
export async function checkDatabase() {
  const startedAt = process.hrtime.bigint();
  await prisma.$queryRaw`SELECT 1`;
  const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
  return { status: 'up', latencyMs: Number(ms.toFixed(2)) };
}

/**
 * Espera activa a que MySQL acepte conexiones.
 *
 * El plan gratuito de Aiven apaga el servicio cuando lleva un rato sin usarse.
 * Cuando eso pasa, la primera conexión falla con "Can't reach database server"
 * aunque la URL sea correcta: no es un error de configuración, es que el
 * servidor está despertándose. Reintentar evita que Render reinicie el
 * proceso en bucle mientras tanto.
 *
 * No lanza si se agotan los intentos: el servidor DEBE arrancar igualmente
 * para poder responder /health con un 503 explicativo. Un proceso que muere
 * deja a Render reiniciándolo cada minuto y consume las 750 horas gratis del
 * mes sin servir a nadie.
 */
export async function connectDatabase({ retries = env.DB_CONNECT_RETRIES, delayMs = env.DB_CONNECT_RETRY_MS, onAttempt } = {}) {
  const attempts = retries + 1;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await prisma.$connect();
      await prisma.$queryRaw`SELECT 1`;
      logger.info('Base de datos conectada', { intento: attempt });
      return { connected: true, attempts: attempt };
    } catch (error) {
      const last = attempt === attempts;
      logger.warn(last ? 'Base de datos no disponible' : 'Reintentando conexión con MySQL', {
        intento: attempt,
        de: attempts,
        error: error.message
      });
      onAttempt?.(attempt, error);
      if (last) return { connected: false, attempts: attempt, error: error.message };

      // Espera exponencial suave: 3s, 6s, 12s… sin pasar de 15s.
      await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs * 2 ** (attempt - 1), 15_000)));
    }
  }
}

/** Cierre ordenado: corta el pool de conexiones antes de morir. */
export async function disconnectDatabase() {
  await prisma.$disconnect();
}