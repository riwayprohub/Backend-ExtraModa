import { Router } from 'express';
import { orderController } from './order.controller.js';
import {
  checkoutSchema,
  orderKeyParamSchema,
  cancelOrderSchema,
  listOrdersQuerySchema
} from './order.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';

const router = Router();

// Sin carrito invitado, el checkout exige sesión: el pedido necesita una
// dirección, un email y un historial al que colgarlo.
/**
 * POST   /api/v1/orders            → hacer el pedido (checkout)
 * GET    /api/v1/orders            → historial del cliente
 * GET    /api/v1/orders/:key       → detalle por número legible o id
 * POST   /api/v1/orders/:key/cancel
 */
router.use(authenticate);

router.post('/', validate({ body: checkoutSchema }), orderController.checkout);
router.get('/', validate({ query: listOrdersQuerySchema }), orderController.list);
router.get('/:key', validate({ params: orderKeyParamSchema }), orderController.detail);
router.post(
  '/:key/cancel',
  validate({ params: orderKeyParamSchema, body: cancelOrderSchema }),
  orderController.cancel
);

export { router as orderRoutes };
