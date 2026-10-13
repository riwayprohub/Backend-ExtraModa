import { Router } from 'express';
import { imageController } from './image.controller.js';
import { imageIdParamSchema } from './product.schema.js';
import { validate } from '../../middlewares/validate.js';

/**
 * Servidor de imágenes subidas por el admin.
 *
 * Va separado de /products a propósito: /products/:key acepta slug o id
 * con un `z.string().max(191)` bastante permisivo, así que colgar las imágenes
 * de ahí haría que un id de imagen devolviera un confuso "Producto no
 * encontrado" en lugar de la foto.
 */
const router = Router();

/**
 * GET /api/v1/images/:id
 *
 * Público a propósito: una etiqueta <img> no lleva cabecera Authorization, y
 * bloquearlo obligaría a firmar cada URL con un token. No es información
 * sensible: son fotos de catálogo que ya se sirven en abierto desde la web.
 */
router.get('/:id', validate({ params: imageIdParamSchema }), imageController.serve);

export { router as imageRoutes };