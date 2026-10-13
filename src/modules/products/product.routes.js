import { Router } from 'express';
import { productController } from './product.controller.js';
import {
  listProductsQuerySchema,
  listProductsAdminQuerySchema,
  productKeyParamSchema,
  productImageParamSchema,
  archiveQuerySchema
} from './product.schema.js';
import { validate } from '../../middlewares/validate.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { authorize } from '../../middlewares/authorize.js';
import { handleUpload } from '../../middlewares/upload.js';

const router = Router();

/**
 * Catálogo: lecturas públicas, escritura restringida a ADMIN/EDITOR.
 *
 * El orden importa: `authenticate` → `authorize` → `validate` → controller.
 * Validar antes de autenticar regalaría información sobre el esquema a un
 * visitante anónimo, y `authorize` sin `authenticate` nunca tendría `req.user`.
 */

// ── Público ───────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/products/facets
 * ANTES de /:key: esa ruta acepta cualquier slug, y "facets" se quedaría
 * engullida por ella si se declarara después.
 */
router.get('/facets', productController.facets);

/**
 * GET /api/v1/products/manage — listado del panel de administración.
 *
 * ANTES de /:key a propósito: "manage" es un slug válido y si fuera declarada
 * después se quedaría engullida por /:key devolviendo "Producto no
 * encontrado". Incluye DRAFT y ARCHIVED, así que va protegida por rol: esa
 * información no es pública.
 */
router.get(
  '/manage',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ query: listProductsAdminQuerySchema }),
  productController.listForAdmin
);

/** GET /api/v1/products/manage/:key — detalle del panel en cualquier estado */
router.get(
  '/manage/:key',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: productKeyParamSchema }),
  productController.getForAdmin
);

/**
 * GET /api/v1/products
 * Filtros (todos opcionales y combinables):
 *   ?q=lino&category=pantalones-hombre&sizes=s,m&colors=arena
 *   &minPrice=20&maxPrice=80&featured=true&inStock=true&sort=price_asc
 *   &page=2&perPage=24
 */
router.get('/', validate({ query: listProductsQuerySchema }), productController.list);

/** GET /api/v1/products/:key — acepta slug o id */
router.get('/:key', validate({ params: productKeyParamSchema }), productController.getByKey);

// ── ADMIN / EDITOR ───────────────────────────────────────────────────────────

/** POST /api/v1/products — alta con variantes anidadas, en una transacción */
router.post(
  '/',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  productController.create
);

/** PATCH /api/v1/products/:key — actualización parcial (no destructiva) */
router.patch(
  '/:key',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: productKeyParamSchema }),
  productController.update
);

/**
 * DELETE /api/v1/products/:key — baja LÓGICA (ARCHIVED).
 * `?hard=true` borra de verdad, pero el service lo impide si el producto
 * ya aparece en algún pedido.
 */
router.delete(
  '/:key',
  authenticate,
  authorize('ADMIN'),
  validate({ params: productKeyParamSchema, query: archiveQuerySchema }),
  productController.archive
);

/** POST /api/v1/products/:key/variants — nueva talla/color sobre un producto */
router.post(
  '/:key/variants',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: productKeyParamSchema }),
  productController.addVariant
);

/** POST /api/v1/products/:key/images — multipart/form-data, campo `image` */
router.post(
  '/:key/images',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  handleUpload,
  validate({ params: productKeyParamSchema }),
  productController.addImage
);

/**
 * DELETE /api/v1/products/images/:imageId — borra una foto por su id.
 *
 * Va en su propio subpath (`/images/:id`) y NO colgando de `/:key`: desde el
 * panel se borra la imagen que se está viendo, que tiene id propio, y el
 * producto se deduce de ella. Así no hace falta acertar también el slug.
 */
router.delete(
  '/images/:imageId',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  validate({ params: productImageParamSchema }),
  productController.removeImage
);

/** PATCH /api/v1/products/variants/:variantId/stock — ajuste por delta o absoluto */
router.patch(
  '/variants/:variantId/stock',
  authenticate,
  authorize('ADMIN', 'EDITOR'),
  productController.adjustStock
);

export { router as productRoutes };
