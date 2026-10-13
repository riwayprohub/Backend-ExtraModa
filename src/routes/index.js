import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.routes.js';
import { productRoutes } from '../modules/products/product.routes.js';
import { imageRoutes } from '../modules/products/image.routes.js';
import { categoryRoutes } from '../modules/categories/category.routes.js';
import { couponRoutes } from '../modules/coupons/coupon.routes.js';
import { siteImageRoutes } from '../modules/site-images/site-image.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { cartRoutes } from '../modules/cart/cart.routes.js';
import { orderRoutes } from '../modules/orders/order.routes.js';

/**
 * Router raíz de la API. Todo lo que se monte aquí vive bajo /api/v1.
 *
 * Para añadir un módulo:
 *   1. src/modules/<nombre>/<nombre>.routes.js
 *   2. import + router.use('/<nombre>', <nombre>Routes)
 *
 * Regla: cada módulo es responsable de su propio prefijo interno y de sus
 * middlewares. Aquí solo se compone.
 */
const router = Router();

router.get('/', (req, res) =>
  res.json({
    success: true,
    data: {
      name: 'Extramoda API',
      version: 'v1',
      docs: '/api/v1/health',
      endpoints: [
        '/api/v1/health',
        '/api/v1/products',
        '/api/v1/products/:slug',
        '/api/v1/images/:id',
        '/api/v1/site-images',
        '/api/v1/categories',
        '/api/v1/coupons',
        '/api/v1/auth/register|login|refresh|logout|me',
        '/api/v1/cart',
        '/api/v1/orders'
      ]
    }
  })
);

router.use('/health', healthRoutes);
router.use('/products', productRoutes);
router.use('/images', imageRoutes);
router.use('/site-images', siteImageRoutes);
router.use('/categories', categoryRoutes);
router.use('/coupons', couponRoutes);
router.use('/auth', authRoutes);
router.use('/cart', cartRoutes);
router.use('/orders', orderRoutes);

export const routes = router;
