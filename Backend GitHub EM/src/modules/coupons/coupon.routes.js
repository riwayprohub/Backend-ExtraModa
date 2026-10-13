import { Router } from 'express';
import { couponController } from './coupon.controller.js';
import { couponIdParamSchema, listCouponsQuerySchema } from './coupon.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';

const router = Router();

/**
 * Promociones: todo el módulo es de ADMIN/EDITOR.
 *
 * No hay lectura pública de cupones a propósito: el catálogo no necesita
 * conocerlos y el carrito ya valida el código al aplicarlo (cart.service).
 */

router.get(
  '/',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ query: listCouponsQuerySchema }),
  couponController.list
);

router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  couponController.create
);

router.patch(
  '/:id',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: couponIdParamSchema }),
  couponController.update
);

router.delete(
  '/:id',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: couponIdParamSchema }),
  couponController.remove
);

export { router as couponRoutes };
