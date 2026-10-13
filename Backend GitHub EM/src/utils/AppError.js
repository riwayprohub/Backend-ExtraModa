/**
 * Error de aplicación: errores OPERACIONALES previstos (404, 409, 403...).
 * El errorHandler los traduce a respuestas HTTP limpias sin registrar stack.
 *
 * Cualquier otra excepción se considera un bug y se reporta como 500.
 */
export class AppError extends Error {
  constructor(message, { statusCode = 500, code = 'INTERNAL_ERROR', details, cause } = {}) {
    super(message, { cause });
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, AppError);
  }

  static badRequest(message = 'Petición inválida', details) {
    return new AppError(message, { statusCode: 400, code: 'BAD_REQUEST', details });
  }

  static unauthorized(message = 'No autenticado', details) {
    return new AppError(message, { statusCode: 401, code: 'UNAUTHORIZED', details });
  }

  static forbidden(message = 'Acceso denegado', details) {
    return new AppError(message, { statusCode: 403, code: 'FORBIDDEN', details });
  }

  static notFound(message = 'Recurso no encontrado', details) {
    return new AppError(message, { statusCode: 404, code: 'NOT_FOUND', details });
  }

  static conflict(message = 'Conflicto con el estado actual', details) {
    return new AppError(message, { statusCode: 409, code: 'CONFLICT', details });
  }

  /** 409 por valor duplicado: mismo código que Prisma P2002, para que el
   *  cliente pueda tratarlos igual (p. ej. Pintando el email del formulario). */
  static duplicate(message = 'Ya existe un registro con ese valor', details) {
    return new AppError(message, { statusCode: 409, code: 'DUPLICATE', details });
  }

  static unprocessable(message = 'Los datos no pasan la validación', details) {
    return new AppError(message, { statusCode: 422, code: 'VALIDATION_ERROR', details });
  }

  static internal(message = 'Error interno del servidor') {
    return new AppError(message, { statusCode: 500, code: 'INTERNAL_ERROR' });
  }
}