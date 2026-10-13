/**
 * Proyección de usuario a JSON: lista explícita de campos.
 * `passwordHash` nunca sale de aquí, aunque se añada al `include`.
 */
export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    firstName: user.firstName,
    lastName: user.lastName,
    fullName: `${user.firstName} ${user.lastName}`,
    phone: user.phone ?? null,
    role: user.role,
    isVerified: user.isVerified,
    createdAt: user.createdAt
  };
}

export function toSessionSummary(session) {
  return {
    id: session.id,
    userAgent: session.userAgent ?? null,
    ipAddress: session.ipAddress ?? null,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    // Permite al usuario reconocer "este dispositivo" en la lista de sesiones
    isCurrent: session.isCurrent === true
  };
}