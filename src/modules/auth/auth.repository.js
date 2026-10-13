import { prisma } from '../../config/database.js';

/** Acceso a datos de identidad y sesiones. Nada de req/res aquí. */

export function findUserByEmail(email) {
  return prisma.user.findUnique({ where: { email } });
}

export function findUserById(id) {
  return prisma.user.findUnique({ where: { id } });
}

export function createUser(data) {
  return prisma.user.create({
    data: { ...data, role: 'CUSTOMER' } // el rol SIEMPRE se fuerza aquí, no viene del cliente
  });
}

export function updateUser(id, data) {
  return prisma.user.update({ where: { id }, data });
}

export function listUsers({ page, perPage, role, q }) {
  const where = {
    ...(role ? { role } : {}),
    ...(q
      ? {
          OR: [
            { email: { contains: q.toLowerCase() } },
            { firstName: { contains: q } },
            { lastName: { contains: q } }
          ]
        }
      : {})
  };

  return Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({
      where,
      skip: (page - 1) * perPage,
      take: perPage,
      orderBy: { createdAt: 'desc' }
    })
  ]).then(([total, items]) => ({ total, items }));
}

export function createSession(data) {
  return prisma.session.create({ data });
}

export function findSessionByTokenHash(refreshTokenHash) {
  return prisma.session.findUnique({
    where: { refreshTokenHash },
    include: { user: true }
  });
}

export function findSessionsByUser(userId) {
  return prisma.session.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' }
  });
}

export function revokeSession(id, userId) {
  return prisma.session.updateMany({
    // userId en el where: impide revocar la sesión de otro con solo conocer el id
    where: { id, userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/**
 * Cierre de emergencia: invalida todas las sesiones del usuario.
 * Se dispara cuando se detecta reutilización de un refresh token ya rotado.
 */
export function revokeAllSessions(userId) {
  return prisma.session.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

/** Rotación: revoca la vieja y crea la nueva en una transacción (todo o nada). */
export async function rotateSession({ oldSessionId, userId, newSessionData }) {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.session.updateMany({
      where: { id: oldSessionId, userId, revokedAt: null },
      data: { revokedAt: new Date() }
    });

    // 0 filas = alguien ya la había revocado (ataque de reutilización)
    if (updated.count === 0) throw new Error('SESSION_ALREADY_ROTATED');

    return tx.session.create({ data: newSessionData });
  });
}