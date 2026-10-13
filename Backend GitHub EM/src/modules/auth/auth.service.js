import { AppError } from '../../utils/AppError.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
  hashToken,
  hashPassword,
  verifyPassword,
  newTokenId,
  refreshTokenExpiry
} from '../../utils/tokens.js';
import * as repository from './auth.repository.js';
import { toPublicUser, toSessionSummary } from './auth.mapper.js';

const MAX_SESSIONS_PER_USER = 10;

export const authService = {
  async register({ firstName, lastName, email, password, phone }, context) {
    const existing = await repository.findUserByEmail(email);
    if (existing) {
      // En registro sí revelamos el conflicto: el usuario necesita saber qué corregir.
      throw AppError.duplicate('Ya existe una cuenta con ese email', { email: 'Email ya registrado' });
    }

    const passwordHash = await hashPassword(password);

    const user = await repository.createUser({
      firstName,
      lastName,
      email,
      phone: phone ?? null,
      passwordHash
    });

    const tokens = await issueSession(user, context);
    return { user: toPublicUser(user), ...tokens };
  },

  async login({ email, password }, context) {
    const user = await repository.findUserByEmail(email);

    // Mismo mensaje y mismo coste para email inexistente y contraseña incorrecta:
    // si no, un atacante puede enumerar las cuentas registradas.
    const passwordMatches = user
      ? await verifyPassword(password, user.passwordHash)
      : await verifyPassword(password, DUMMY_HASH);

    if (!user || !passwordMatches) {
      throw AppError.unauthorized('Credenciales incorrectas');
    }
    if (!user.isActive) {
      throw AppError.forbidden('Tu cuenta está desactivada. Contacta con atención al cliente.');
    }

    await repository.updateUser(user.id, { lastLoginAt: new Date() });

    const tokens = await issueSession(user, context);
    return { user: toPublicUser(user), ...tokens };
  },

  async refresh(refreshToken, context) {
    const payload = verifyRefreshToken(refreshToken);
    const tokenHash = hashToken(refreshToken);

    const session = await repository.findSessionByTokenHash(tokenHash);

    // Token válido criptográficamente pero revocado = alguien reutilizó un token
    // ya rotado. Posible robo: cerramos TODAS las sesiones del usuario.
    if (session?.revokedAt) {
      await repository.revokeAllSessions(session.userId);
      throw AppError.unauthorized(
        'Se ha detectado una sesión duplicada. Por seguridad, cierra sesión en todos tus dispositivos.',
        { code: 'TOKEN_REUSE_DETECTED' }
      );
    }

    if (!session || session.expiresAt <= new Date() || session.userId !== payload.sub) {
      throw AppError.unauthorized('Sesión no válida', { code: 'REFRESH_EXPIRED' });
    }

    const user = session.user;
    if (!user.isActive) {
      await repository.revokeAllSessions(user.id);
      throw AppError.forbidden('Tu cuenta está desactivada');
    }

    const jti = newTokenId();
    const newRefreshToken = signRefreshToken(user, jti);

    try {
      await repository.rotateSession({
        oldSessionId: session.id,
        userId: user.id,
        newSessionData: buildSessionData(user.id, newRefreshToken, context)
      });
    } catch (error) {
      if (error.message === 'SESSION_ALREADY_ROTATED') {
        await repository.revokeAllSessions(user.id);
        throw AppError.unauthorized('Sesión duplicada detectada. Vuelve a iniciar sesión.', {
          code: 'TOKEN_REUSE_DETECTED'
        });
      }
      throw error;
    }

    return { user: toPublicUser(user), accessToken: signAccessToken(user), refreshToken: newRefreshToken };
  },

  async logout(refreshToken) {
    if (!refreshToken) return;

    const payload = verifyRefreshToken(refreshToken);
    await repository.revokeAllSessions(payload.sub);
  },

  async me(userId) {
    const user = await repository.findUserById(userId);
    if (!user) throw AppError.notFound('El usuario ya no existe');
    return toPublicUser(user);
  },

  async updateProfile(userId, data) {
    const user = await repository.updateUser(userId, data);
    return toPublicUser(user);
  },

  async listSessions(userId, refreshToken) {
    // La sesión actual se identifica comparando el hash del token de la cookie:
    // así el frontend puede marcar "este dispositivo" sin inventar campos.
    const current = refreshToken ? await repository.findSessionByTokenHash(hashToken(refreshToken)) : null;
    const sessions = await repository.findSessionsByUser(userId);

    return sessions.map((session) => toSessionSummary({ ...session, isCurrent: session.id === current?.id }));
  },

  async revokeSession(userId, sessionId) {
    const { count } = await repository.revokeSession(sessionId, userId);
    if (count === 0) throw AppError.notFound('Esa sesión no existe o ya estaba cerrada');
  },

  async listUsers({ page, perPage, role, q }) {
    const { total, items } = await repository.listUsers({ page, perPage, role, q });
    return { items, total };
  }
};

/** Emite un access token y crea la sesión persistente del refresh token. */
async function issueSession(user, context) {
  await limitSessions(user.id);

  const refreshToken = signRefreshToken(user, newTokenId());
  await repository.createSession(buildSessionData(user.id, refreshToken, context));

  return { accessToken: signAccessToken(user), refreshToken };
}

/** Solo campos que existen en el modelo Session. El token nunca se guarda en claro. */
function buildSessionData(userId, refreshToken, context = {}) {
  return {
    userId,
    refreshTokenHash: hashToken(refreshToken),
    expiresAt: refreshTokenExpiry(),
    userAgent: context.userAgent?.slice(0, 255) ?? null,
    ipAddress: context.ip ?? null
  };
}

/** Mantiene acotadas las sesiones activas por usuario (pestañas y dispositivos). */
async function limitSessions(userId) {
  const sessions = await repository.findSessionsByUser(userId);
  const excess = sessions.length - MAX_SESSIONS_PER_USER + 1;

  if (excess > 0) {
    for (const session of sessions.slice(-excess)) {
      await repository.revokeSession(session.id, userId);
    }
  }
}

/**
 * Hash señuelo: se compara contra él cuando el email no existe para que el
 * tiempo de respuesta sea el mismo que con una contraseña real (evita
 * enumeración de cuentas por *timing*).
 */
const DUMMY_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO1sJ0VfM9p1Kz1nT7YV5oR8sQ2wLx3dUe';