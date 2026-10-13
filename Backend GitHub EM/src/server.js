import app from './app.js';
import { env, PORT } from './config/env.js';
import { logger } from './config/logger.js';
import { prisma, connectDatabase, disconnectDatabase } from './config/database.js';
import { seedIfEmpty } from './config/seedOnBoot.js';

/**
 * Punto de entrada. Arranca y apaga: toda la configuración vive en app.js.
 *
 * Escuchamos en 0.0.0.0 (no en localhost) porque dentro del contenedor de Render
 * el proceso solo es alcanzable desde la red externa si vincula todas las
 * interfaces. Y el puerto lo inyecta la plataforma: Render asigna uno libre y
 * lo pasa en PORT, ignorando cualquier valor fijo.
 */
const HOST = '0.0.0.0';

/**
 * El servidor escucha ANTES de tocar la base de datos, y a propósito.
 *
 * El MySQL de Aiven en plan gratuito se apaga solo tras un rato sin actividad,
 * así que al arrancar puede tardar segundos en aceptar conexiones. Si esperásemos
 * a la base antes de listen(), Render vería el puerto cerrado durante ese
 * intervalo, lo contaría como arranque fallido y repetiría el despliegue.
 * Con este orden el proceso responde /healthz de inmediato y la base se conecta
 * en segundo plano.
 */
const server = app.listen(PORT, HOST, () => {
  logger.info(`Extramoda escuchando en http://${HOST}:${PORT}`, {
    entorno: env.NODE_ENV,
    cors: env.corsOrigins,
    spa: env.SERVE_SPA
  });
  logger.info(`API: /api/v1 | Sonda de vida: /healthz | Estado de la base: /api/v1/health`);

  connectDatabase().then(({ connected }) => {
    if (!connected) {
      logger.warn('Arrancamos sin base de datos: /api responderá 503 hasta que Aiven la encienda');
      return;
    }
    if (env.SEED_ON_BOOT) {
      seedIfEmpty().catch((error) => logger.error('Error en el seed de arranque', { error: error.message }));
    }
  });
});

// Render manda SIGTERM al apagar o redeployar. Express deja de aceptar
// conexiones y se corta el pool de Prisma para no dejar conexiones colgadas.
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // doble Ctrl+C no debe duplicar el trabajo
  shuttingDown = true;

  logger.info(`${signal} recibido, cerrando el servidor...`);

  // 1. Dejar de aceptar conexiones nuevas
  server.close(async () => {
    // 2. Cerrar el pool de Prisma
    try {
      await disconnectDatabase();
      logger.info('Conexiones de base de datos cerradas');
    } catch (error) {
      logger.error('Error cerrando Prisma', { error: error.message });
    }
    logger.info('Apagado completado');
    process.exit(0);
  });

  // 3. Si algo se atasca, forzamos la salida
  setTimeout(() => {
    logger.error('Apagado forzado tras 10s: hay conexiones que no cierran');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Unhandled rejection = bug. Se registra y se muere: seguir con estado
// inconsistente es peor que un reinicio limpio.
process.on('unhandledRejection', (reason) => {
  logger.error('Promesa rechazada sin manejar', { reason: reason?.message ?? reason, stack: reason?.stack });
  shutdown('unhandledRejection');
});

process.on('uncaughtException', (error) => {
  logger.error('Excepción no capturada', { error: error.message, stack: error.stack });
  shutdown('uncaughtException');
});

/**
 * Vigilancia del event loop.
 *
 * El truco está en comparar la HORA ESPERADA con la HORA REAL: si el bucle
 * estuviera bloqueado de verdad, el callback ni siquiera podría ejecutarse a su
 * hora, así que un `setInterval` que se cumple siempre significa "el bucle está
 * vivo" y uno que se retrasa varios minutos significa "el bucle estaba atascado".
 *
 * Un simple `setInterval(() => shutdown(), 300_000)` — sin mirar la deriva —
 * mataría el servidor cada 5 minutos aunque todo funcionase perfectamente.
 */
const WATCHDOG_TICK_MS = 60_000;
const WATCHDOG_DRIFT_MS = 5 * 60_000;

let lastTick = Date.now();

const watchdog = setInterval(() => {
  const now = Date.now();
  const drift = now - lastTick - WATCHDOG_TICK_MS;
  lastTick = now;

  if (drift > WATCHDOG_DRIFT_MS) {
    logger.error(`Event loop bloqueado ${Math.round(drift / 1000)}s: reiniciando el proceso`);
    shutdown('watchdog');
  }
}, WATCHDOG_TICK_MS);

// .unref() para que este temporizador no mantenga vivo el proceso al apagar.
watchdog.unref();

export { prisma };