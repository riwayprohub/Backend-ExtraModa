import { Router } from 'express';
import { siteImageController } from './site-image.controller.js';
import { slotParamSchema } from './site-image.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { handleUpload } from '../../middlewares/upload.js';

const router = Router();

/**
 * Imágenes del escaparate de inicio.
 *
 * Lectura pública (la portada las pide sin sesión) y escritura solo para
 * ADMIN/EDITOR. `GET /:slot` sirve el binario: va declarado antes que nada que
 * pudiera capturarlo, y el validador limita el hueco a la lista cerrada del
 * schema, así que no caducará en un 404 elegante.
 */

// ── Público ───────────────────────────────────────────────────────────────────

router.get('/', siteImageController.list);

router.get(
  '/:slot',
  validate({ params: slotParamSchema }),
  siteImageController.serve
);

// ── ADMIN / EDITOR ───────────────────────────────────────────────────────────

router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  handleUpload,
  siteImageController.upload
);

router.delete(
  '/:slot',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: slotParamSchema }),
  siteImageController.remove
);

export { router as siteImageRoutes };
