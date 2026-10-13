import { Router } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../../config/env.js';
import { authController } from './auth.controller.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  sessionParamsSchema,
  updateProfileSchema,
  listUsersQuerySchema
} from './auth.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';

const router = Router();

/**
 * Límite de intentos por IP + email (no solo por IP): frena el credential
 * stuffing dirigido a una cuenta concreta sin perjudicar a los usuarios que
 * comparten NAT en una oficina.
 *
 * El store en memoria no sirve con varias instancias: en producción hay que
 * usar Redis (`rate-limit-redist`) o el rate limit será por proceso.
 *
 * Es una factory para poder verificarlo en tests (con `skipInTest: false` y
 * límites propios) en vez de tener la lógica sin cobertura.
 */
export function createLoginLimiter({ limit = 10, windowMs = 15 * 60 * 1000, skipInTest = true } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipInTest && env.NODE_ENV === 'test' ? () => true : undefined,
    keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${(req.body?.email ?? '').toLowerCase()}`,
    message: {
      success: false,
      code: 'TOO_MANY_ATTEMPTS',
      message: 'Demasiados intentos de acceso. Inténtalo de nuevo en 15 minutos.'
    }
  });
}

export function createRegisterLimiter({ limit = 5, windowMs = 60 * 60 * 1000, skipInTest = true } = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: skipInTest && env.NODE_ENV === 'test' ? () => true : undefined,
    message: {
      success: false,
      code: 'TOO_MANY_REGISTRATIONS',
      message: 'Demasiadas cuentas creadas desde esta conexión. Inténtalo más tarde.'
    }
  });
}

const loginLimiter = createLoginLimiter();
const registerLimiter = createRegisterLimiter();

// ── Público ───────────────────────────────────────────────────────────────────
router.post('/register', registerLimiter, validate({ body: registerSchema }), authController.register);
router.post('/login', loginLimiter, validate({ body: loginSchema }), authController.login);
router.post('/refresh', validate({ body: refreshSchema }), authController.refresh);
router.post('/logout', optionalAuthenticate, authController.logout);

// ── Requiere access token ─────────────────────────────────────────────────────
router.get('/me', authenticate, authController.me);
router.patch('/me', authenticate, validate({ body: updateProfileSchema }), authController.updateProfile);

router.get('/sessions', authenticate, authController.listSessions);
router.delete(
  '/sessions/:id',
  authenticate,
  validate({ params: sessionParamsSchema }),
  authController.revokeSession
);

// ── Solo ADMIN ───────────────────────────────────────────────────────────────
router.get(
  '/admin/users',
  authenticate,
  authorize('ADMIN'),
  validate({ query: listUsersQuerySchema }),
  authController.listUsers
);

export { router as authRoutes };