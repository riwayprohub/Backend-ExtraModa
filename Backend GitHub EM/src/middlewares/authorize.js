import { AppError } from '../utils/AppError.js';

/**
 * Autorización por rol. Va SIEMPRE después de `authenticate`.
 *
 *   router.post('/', authenticate, authorize('ADMIN'), controller.create)
 *   router.get('/', authenticate, authorize('ADMIN', 'EDITOR'), controller.list)
 *
 * Restricción de empleo, no de seguridad: el check real de permisos (qué puede
 * hacer un ADMIN con un pedido) se resuelve en el service, no en el middleware.
 */
export function authorize(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      return next(AppError.unauthorized());
    }
    if (!allowedRoles.includes(req.user.role)) {
      return next(
        AppError.forbidden(`Esta acción requiere uno de estos roles: ${allowedRoles.join(', ')}`)
      );
    }
    next();
  };
}