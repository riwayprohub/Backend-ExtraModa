import { verifyAccessToken } from '../utils/tokens.js';
import { AppError } from '../utils/AppError.js';

/**
 * Exige un access token válido.
 *
 *   router.patch('/me', authenticate, controller.updateProfile)
 *
 * Adjunta `req.user = { id, email, role }` a partir de los claims del JWT, sin
 * tocar la base de datos: es una operación por petición menos.
 *
 * Consecuencia asumida: si se desactiva o elimina una cuenta, sus tokens siguen
 * valiendo hasta 15 minutos. Si necesitas revocación inmediata, añade una
 * comprobación de `isActive` contra la BD (o una lista de revocación).
 */
export function authenticate(req, _res, next) {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return next(AppError.unauthorized('Falta la cabecera Authorization: Bearer <token>'));
  }

  const token = header.slice(7).trim();

  try {
    const payload = verifyAccessToken(token);
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (error) {
    next(error);
  }
}

/** Adjunta req.user sin exigir token: útil para acciones opcionales (favoritos). */
export function optionalAuthenticate(req, _res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next();

  try {
    const payload = verifyAccessToken(header.slice(7).trim());
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
  } catch {
    // Token inválido en una ruta opcional: se ignora en lugar de fallar
  }
  next();
}