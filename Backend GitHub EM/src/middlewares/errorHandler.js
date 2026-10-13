import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { AppError } from '../utils/AppError.js';

/**
 * Traduce CUALQUIER error a la respuesta uniforme de la API.
 * Debe ser el ÚLTIMO middleware de la pila (app.use(errorHandler)).
 *
 * Regla de seguridad: en producción nunca devolvemos el mensaje ni el stack
 * de un error no previsto, solo un código y un id para correlacionar logs.
 */
export function errorHandler(err, req, res, _next) {
  const { statusCode, code, message, details, expose } = normalize(err);

  if (statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} → ${code}`, {
      error: err.message,
      stack: err.stack,
      requestId: req.id
    });
  } else {
    logger.warn(`${req.method} ${req.originalUrl} → ${statusCode} ${code}`, {
      message,
      ...(details && { details })
    });
  }

  const body = { code, message };
  if (details) body.errors = details;
  if (!env.isProd && statusCode >= 500) body.stack = err.stack;
  if (!expose && !env.isProd) body.originalError = { name: err.name, message: err.message };
  return res.status(statusCode).json({ success: false, ...body });
}

function normalize(err) {
  // 1. Errores previstos de negocio
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, code: err.code, message: err.message, details: err.details, expose: true };
  }

  // 2. Zod (validaciones que se saltaron el middleware, p. ej. en services)
  if (err instanceof ZodError) {
    const errors = {};
    for (const issue of err.issues) errors[issue.path.join('.') || '_'] ??= issue.message;
    return { statusCode: 422, code: 'VALIDATION_ERROR', message: 'Los datos enviados no son válidos', details: errors, expose: true };
  }

  // 3. Prisma: traducimos los códigos comunes a lenguaje de negocio
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return { ...fromPrisma(err), expose: true };
  }

  // 3-bis. MySQL inalcanzable: el plan gratuito de Aiven apaga el servicio por
  // inactividad. No es un bug del servidor, así que se responde 503 (reintentable)
  // y no 500, que el frontend trata como error definitivo sin volver a probar.
  if (isDatabaseUnreachable(err)) {
    return {
      statusCode: 503,
      code: 'DATABASE_UNAVAILABLE',
      message: 'La base de datos se está activando. Vuelve a intentarlo en unos segundos.',
      expose: true
    };
  }

  // 4. JSON malformado (express.json lanza SyntaxError)
  if (err instanceof SyntaxError && 'body' in err) {
    return { statusCode: 400, code: 'INVALID_JSON', message: 'El cuerpo de la petición no es JSON válido', expose: true };
  }

  // 5. Límite de tamaño de carga
  if (err.type === 'entity.too.large') {
    return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'El cuerpo supera el tamaño máximo permitido', expose: true };
  }

  // 6. Bug: no revelamos nada en producción
  return {
    statusCode: err.statusCode ?? 500,
    code: err.code ?? 'INTERNAL_ERROR',
    message: err.message ?? 'Error interno del servidor',
    expose: false
  };
}

/**
 * Detecta "no se puede alcanzar el servidor MySQL".
 *
 * MySQL lanza una decena de variantes del mismo problema (P1001 "can't reach
 * database server", P1008 "operations timed out", "Connection refused"...).
 * Todas significan lo mismo para quien llama: reintentar más tarde.
 */
function isDatabaseUnreachable(err) {
  const code = err?.code;
  if (typeof code === 'string' && (code.startsWith('P100') || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'PROTOCOL_CONNECTION_LOST')) {
    return true;
  }
  const message = err?.message ?? '';
  return (
    message.includes("Can't reach database server") ||
    message.includes('Connection refused') ||
    message.includes('Connection closed unexpectedly') ||
    message.includes('server has gone away') ||
    message.includes('Read timed out')
  );
}

function fromPrisma(err) {
  switch (err.code) {
    case 'P2002': {
      const target = Array.isArray(err.meta?.target) ? err.meta.target.join(', ') : err.meta?.target;
      return {
        statusCode: 409,
        code: 'DUPLICATE',
        message: `Ya existe un registro con ese valor${target ? ` (${target})` : ''}`,
        details: target ? { [target.split(', ')[0]]: 'Valor duplicado' } : undefined
      };
    }
    case 'P2025':
      return { statusCode: 404, code: 'NOT_FOUND', message: 'El recurso solicitado no existe' };
    case 'P2003':
      return { statusCode: 400, code: 'FOREIGN_KEY', message: 'Una referencia relacionada no es válida' };
    case 'P2034':
      return { statusCode: 409, code: 'TRANSACTION_CONFLICT', message: 'Conflicto de transacción, reintenta' };
    default:
      return { statusCode: 500, code: `PRISMA_${err.code}`, message: 'Error de base de datos' };
  }
}