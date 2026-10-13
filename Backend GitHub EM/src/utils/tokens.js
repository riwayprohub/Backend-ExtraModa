import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { AppError } from './AppError.js';

/**
 * Tokens: dos piezas con propósitos distintos.
 *
 *  · ACCESS TOKEN  (15 min) — JWT corto, va en la cabecera Authorization.
 *    El frontend lo guarda en memoria, NO en localStorage (evita XSS).
 *
 *  · REFRESH TOKEN (7 días) — cookie httpOnly + SameSite. El JavaScript del
 *    navegador nunca lo puede leer, así que un XSS no puede robarlo.
 *
 * El refresh token se guarda hasheado (SHA-256) en la tabla `sessions`: si alguien
 * lee la base de datos no puede suplantar sesiones. Cada refresh rota el token y
 * revoca el anterior, de modo que un token robado solo sirve una vez.
 */

const ALGORITHM = 'HS256';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, email: user.email, role: user.role }, env.JWT_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: env.JWT_EXPIRES_IN
  });
}

export function signRefreshToken(user, jti) {
  return jwt.sign({ sub: user.id, jti }, env.REFRESH_TOKEN_SECRET, {
    algorithm: ALGORITHM,
    expiresIn: env.REFRESH_TOKEN_EXPIRES_IN
  });
}

export function verifyAccessToken(token) {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== 'string') throw new Error('payload inválido');
    return payload;
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      throw AppError.unauthorized('La sesión ha caducado', { code: 'TOKEN_EXPIRED' });
    }
    throw AppError.unauthorized('Token de acceso inválido', { code: 'TOKEN_INVALID' });
  }
}

export function verifyRefreshToken(token) {
  try {
    const payload = jwt.verify(token, env.REFRESH_TOKEN_SECRET, { algorithms: [ALGORITHM] });
    if (!payload.sub || !payload.jti) throw new Error('payload inválido');
    return payload;
  } catch {
    // Mensaje genérico: no revelamos si el problema es la firma o la expiración.
    throw AppError.unauthorized('Sesión no válida', { code: 'REFRESH_INVALID' });
  }
}

export function newTokenId() {
  return crypto.randomUUID();
}

/** SHA-256: suficiente para tokens de alta entropía y rápido de comparar. */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function refreshTokenExpiry() {
  const days = Number.parseInt(env.REFRESH_TOKEN_EXPIRES_IN, 10) || 7;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

/** Hash de contraseñas: bcrypt con 12 rondas (coste ~250 ms en hardware moderno). */
export async function hashPassword(password) {
  const bcrypt = await import('bcryptjs');
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, passwordHash) {
  const bcrypt = await import('bcryptjs');
  return bcrypt.compare(password, passwordHash);
}