import { Router } from 'express';
import { categoryController } from './category.controller.js';
import { categoryIdParamSchema } from './category.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';

const router = Router();

/**
 * Categorías: lectura pública, escritura restringida a ADMIN/EDITOR.
 *
 * `/all` va ANTES de `/:id` solo por claridad: no colisionan porque `/:id`
 * exige un cuid, pero dejar la ruta de panel junto a su guarda evita que
 * alguien la mueva debajo de la pública por accidente.
 */

// ── Público ───────────────────────────────────────────────────────────────────

router.get('/', categoryController.list);

// ── ADMIN / EDITOR ───────────────────────────────────────────────────────────

router.get('/all', authenticate, authorize('ADMIN', 'EDITOR'), categoryController.listAll);

router.post('/', authenticate, authorize('ADMIN', 'EDITOR'), categoryController.create);

router.patch(
  '/order',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  categoryController.reorder
);

router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: categoryIdParamSchema }),
  categoryController.update
);

router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: categoryIdParamSchema }),
  categoryController.remove
);

export { router as categoryRoutes };
