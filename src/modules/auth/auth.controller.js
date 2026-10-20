import { env } from '../../config/env.js';
import { authService } from './auth.service.js';
import { ApiResponse } from '../../utils/ApiResponse.js';
import { toPublicUser } from './auth.mapper.js';
import { AppError } from '../../utils/AppError.js';

export const REFRESH_COOKIE = 'extramoda_rt';

/**
 * El refresh token viaja en una cookie httpOnly: el JavaScript del navegador no
 * puede leerla, así que un XSS no puede robar la sesión larga.
 *
 *  · sameSite 'lax' en desarrollo → el navegador no la envía en peticiones de
 *    otro sitio (protección frente a CSRF en la mayoría de casos).
 *  · sameSite 'none' en producción → el despliegue son DOS servicios Render y
 *    la API y la SPA viven en subdominios distintos de onrender.com, que es un
 *    sufijo público: para el navegador son SITIOS distintos. Con 'lax' el
 *    navegador NO adjuntaba la cookie al fetch cross-origin de /auth/refresh y
 *    el usuario amanecía deslogueado tras cada recarga (comprobado en el sitio
 *    desplegado: la petición de refresh iba sin cookie y respondía 422).
 *    'none' requiere la conexión segura, que en producción ya se exige.
 *  · secure → solo por HTTPS. En Render siempre es HTTPS, así que 'none' es
 *    válido; en desarrollo queda false con localhost.
 *  · path limitado a /api/v1/auth → no se adjunta a cada petición de la API.
 */
function cookieOptions() {
  return {
    httpOnly: true,
    secure: env.isProd,
    sameSite: env.isProd ? 'none' : 'lax',
    path: '/api/v1/auth',
    maxAge: 7 * 24 * 60 * 60 * 1000
  };
}

/** Datos de la petición que queremos guardar junto a la sesión. */
function requestContext(req) {
  return { userAgent: req.get('user-agent'), ip: req.ip };
}

export const authController = {
  async register(req, res) {
    const { user, accessToken, refreshToken } = await authService.register(
      req.validated.body,
      requestContext(req)
    );

    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    ApiResponse.created(res, { user, accessToken }, 'Cuenta creada correctamente');
  },

  async login(req, res) {
    const { user, accessToken, refreshToken } = await authService.login(
      req.validated.body,
      requestContext(req)
    );

    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    ApiResponse.ok(res, {
      data: { user, accessToken },
      message: 'Sesión iniciada'
    });
  },

  async refresh(req, res) {
    const token = req.cookies?.[REFRESH_COOKIE] ?? req.validated.body.refreshToken;

    if (!token) {
      throw AppError.unauthorized('No hay sesión que renovar');
    }

    const { user, accessToken, refreshToken } = await authService.refresh(token, requestContext(req));

    res.cookie(REFRESH_COOKIE, refreshToken, cookieOptions());
    ApiResponse.ok(res, { data: { user, accessToken } });
  },

  async logout(req, res) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) await authService.logout(token);

    res.clearCookie(REFRESH_COOKIE, { ...cookieOptions(), maxAge: undefined });
    ApiResponse.ok(res, { message: 'Sesión cerrada' });
  },

  async me(req, res) {
    ApiResponse.ok(res, { data: { user: await authService.me(req.user.id) } });
  },

  async updateProfile(req, res) {
    ApiResponse.ok(res, {
      data: { user: await authService.updateProfile(req.user.id, req.validated.body) },
      message: 'Perfil actualizado'
    });
  },

  async listSessions(req, res) {
    const sessions = await authService.listSessions(req.user.id, req.cookies?.[REFRESH_COOKIE]);
    ApiResponse.ok(res, { data: { sessions } });
  },

  async revokeSession(req, res) {
    await authService.revokeSession(req.user.id, req.validated.params.id);
    ApiResponse.ok(res, { message: 'Sesión revocada' });
  },

  async listUsers(req, res) {
    const { page, perPage, role, q } = req.validated.query;
    const { items, total } = await authService.listUsers({ page, perPage, role, q });

    ApiResponse.paginated(res, { items: items.map(toPublicUser), total, page, perPage });
  }
};