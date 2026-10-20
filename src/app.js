import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { routes } from './routes/index.js';
import { AppError } from './utils/AppError.js';
import { notFound } from './middlewares/notFound.js';
import { errorHandler } from './middlewares/errorHandler.js';

const app = express();

// ── Proxy / IPs reales ───────────────────────────────────────────────────────
// En producción (nginx, Render, Fly…) el servidor corre detrás de un proxy.
// Sin esto, req.ip devuelve la IP del proxy en los logs y el rate limit agrupa
// a todos los clientes en una sola "IP".
app.set('trust proxy', env.isProd ? 1 : false);
app.disable('x-powered-by');

// ── Seguridad ────────────────────────────────────────────────────────────────
app.use(
  helmet({
    // El backend sirve JSON, no HTML: la CSP del navegador la gestiona el hosting
    // del frontend. Desactivamos aquí para no enviar cabeceras contradictorias.
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' } // permite <img> desde otro origen
  })
);

app.use((req, res, next) => {
  cors({
    origin(origin, callback) {
      // Sin origin = curl, Postman, apps móviles → permitido
      if (!origin) return callback(null, true);

      const host = req.headers.host;
      const isSameOrigin = Boolean(host && (origin === `http://${host}` || origin === `https://${host}`));

      if (isSameOrigin || env.corsOrigins.includes(origin)) return callback(null, true);

      // AppError (no Error genérico) para que errorHandler lo devuelva como 403
      // limpio en lugar de un 500 que filtra el stack.
      logger.warn('Origen bloqueado por CORS', { origin });
      callback(AppError.forbidden('Origen no permitido por CORS'));
    },
    // La cookie de refresh es httpOnly: sin esta cabecera el navegador
    // descarta la respuesta de /auth/login al ser cross-site.
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400
  })(req, res, next);
});

// ── Parsing y rendimiento ────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Necesario para leer el refresh token de la cookie httpOnly
app.use(cookieParser());
app.use(compression());

// ── Logging HTTP ─────────────────────────────────────────────────────────────
// morgan escribe en stdout; en desarrollo añade color y muestra solo 4xx/5xx relevantes.
app.use(
  morgan(env.isProd ? 'combined' : 'dev', {
    skip: (req) => req.originalUrl === '/api/v1/health'
  })
);

// ── Sonda de vida ─────────────────────────────────────────────────────────────
/**
 * GET /healthz — la que usa Render para decidir que el despliegue está vivo.
 *
 * NO toca la base de datos a propósito. El MySQL de Aiven en plan gratuito se
 * apaga por inactividad, y si la sonda comprobara la conexión, cada arranque en
 * frío fallaría y Render marcaría el despliegue como fallido indefinidamente.
 * El estado real de la base está en /api/v1/health.
 */
app.get('/healthz', (_req, res) => res.json({ status: 'ok', service: 'extramoda' }));

// ── Rutas ────────────────────────────────────────────────────────────────────
app.use('/api/v1', routes);

// ── Frontend compilado (mismo proceso, mismo dominio) ────────────────────────
/**
 * Un único servicio Render sirve la API y la SPA. Así el navegador ve un solo
 * origen: la cookie httpOnly del refresh token funciona sin SameSite=None y no
 * hace falta CORS. También evita que el sitioastedezca cargando el HTML del
 * Render estático mientras el backend sigue dormido.
 *
 * Se resuelve la carpeta desde este archivo, no desde el cwd: en producción
 * npm start se ejecuta en backend/, pero en local puede ser desde la raíz del
 * monorepo y `frontend/dist` no se encontraría.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const spaDist = path.resolve(here, '../../frontend/dist');
const spaIndex = path.join(spaDist, 'index.html');

if (env.SERVE_SPA && fs.existsSync(spaIndex)) {
  // Los assets con hash en el nombre (app.a1b2c3.js) se cachean para siempre;
  // index.html nunca, para que un despliegue nuevo traiga las referencias nuevas.
  app.use(
    express.static(spaDist, {
      index: false,
      maxAge: '1y',
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      }
    })
  );

  /**
   * Fallback de la SPA. Va con app.use y no con una ruta '/*' porque Express 5
   * usa path-to-regexp v8 y el comodín debe ir nombrado. Solo responde a
   * navigational requests (HTML): así /api/v1/lo-que-sea sigue cayendo en el
   * 404 JSON de la API en lugar de devolver el index.html con un 200.
   */
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.originalUrl.startsWith('/api/')) return next();
    if (!req.accepts('html')) return next();

    return res.sendFile(spaIndex);
  });

  logger.info('Front-end compilado montado', { spaDist });
} else if (env.SERVE_SPA) {
  logger.warn('SERVE_SPA está activo pero no existe frontend/dist: solo se sirve la API');
}

// ── 404 y manejador de errores (SIEMPRE al final, en este orden) ─────────────
app.use(notFound);
app.use(errorHandler);

export default app;