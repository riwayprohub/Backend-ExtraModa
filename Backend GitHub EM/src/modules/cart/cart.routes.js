import { Router } from 'express';
import { cartController } from './cart.controller.js';
import {
  addItemSchema,
  updateItemSchema,
  itemParamsSchema,
  applyCouponSchema
} from './cart.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';

const router = Router();

// El carrito entero es privado: `authenticate` en todo el router, no endpoint
// a endpoint. Olvidarse de un middleware aquí equivaldría a mezclar el carrito
// de dos personas.
/**
 * GET    /api/v1/cart
 * POST   /api/v1/cart/items          { variantId, quantity? }
 * PATCH  /api/v1/cart/items/:itemId  { quantity }
 * DELETE /api/v1/cart/items/:itemId
 * DELETE /api/v1/cart
 * POST   /api/v1/cart/coupon         { code }
 * DELETE /api/v1/cart/coupon
 */
router.use(authenticate);

router.get('/', cartController.get);
router.post('/items', validate({ body: addItemSchema }), cartController.addItem);
router.patch(
  '/items/:itemId',
  validate({ body: updateItemSchema, params: itemParamsSchema }),
  cartController.updateItem
);
router.delete('/items/:itemId', validate({ params: itemParamsSchema }), cartController.removeItem);
router.delete('/', cartController.clear);
router.post('/coupon', validate({ body: applyCouponSchema }), cartController.applyCoupon);
router.delete('/coupon', cartController.removeCoupon);

export { router as cartRoutes };
