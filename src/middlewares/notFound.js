import { AppError } from '../utils/AppError.js';

/**
 * 404 para cualquier ruta no registrada.
 * Va justo antes de errorHandler.
 */
export function notFound(req, _res, next) {
  next(AppError.notFound(`Ruta no encontrada: ${req.method} ${req.originalUrl}`));
}