import { ApiResponse } from '../../utils/ApiResponse.js';
import { productService } from './product.service.js';
import {
  createProductSchema,
  updateProductSchema,
  createVariantSchema,
  adjustStockSchema,
  variantParamsSchema,
  addImageSchema,
  imageIdParamSchema,
  productImageParamSchema
} from './product.schema.js';

/**
 * Los middleware ya han validado params/query y resuelto la sesión, así que
 * aquí solo queda validar el CUERPO (distinto por endpoint) y formatear.
 *
 * OJO: `ApiResponse.ok` recibe un objeto de opciones, no argumentos sueltos.
 *   ApiResponse.ok(res, { data, message, meta })
 */
export const productController = {
  // ── Público ────────────────────────────────────────────────────────────────

  /**
   * GET /api/v1/products/facets
   *
   * Va declarado ANTES que /:key a propósito: esa ruta acepta cualquier cadena
   * como slug, así que "facets" se colaría en ella y devolvería
   * "Producto no encontrado" en lugar de las facetas.
   */
  async facets(req, res) {
    const data = await productService.facets();

    return ApiResponse.ok(res, { data });
  },

  async list(req, res) {
    const { items, total, page, perPage } = await productService.list(req.validated.query);

    return ApiResponse.paginated(res, { items, total, page, perPage });
  },

  async getByKey(req, res) {
    const data = await productService.getByKey(req.validated.params.key);

    return ApiResponse.ok(res, { data });
  },

  /** Listado del panel: requiere rol; incluye borradores y archivados. */
  async listForAdmin(req, res) {
    const { items, total, page, perPage } = await productService.listForAdmin(req.validated.query);

    return ApiResponse.paginated(res, { items, total, page, perPage });
  },

  /** Detalle del panel por slug o id, en cualquier estado. */
  async getForAdmin(req, res) {
    const data = await productService.getForAdmin(req.validated.params.key);

    return ApiResponse.ok(res, { data });
  },

  // ── ADMIN / EDITOR ─────────────────────────────────────────────────────────

  async create(req, res) {
    const input = createProductSchema.parse(req.body);
    const product = await productService.create(input);

    return ApiResponse.created(res, product, `Producto "${product.name}" creado`);
  },

  async update(req, res) {
    const input = updateProductSchema.parse(req.body);
    const product = await productService.update(req.validated.params.key, input);

    return ApiResponse.ok(res, { data: product, message: 'Producto actualizado' });
  },

  async archive(req, res) {
    const { hard } = req.validated.query;
    const result = await productService.archive(req.validated.params.key, { hard });

    if (result.deleted) {
      return ApiResponse.ok(res, { message: 'Producto eliminado definitivamente' });
    }
    return ApiResponse.ok(res, { data: result.product, message: 'Producto archivado' });
  },

  async addVariant(req, res) {
    const input = createVariantSchema.parse(req.body);
    const variant = await productService.addVariant(req.validated.params.key, input);

    return ApiResponse.created(res, variant, `Variante ${variant.sku} creada`);
  },

  async adjustStock(req, res) {
    const { variantId } = variantParamsSchema.parse(req.params);
    const payload = adjustStockSchema.parse(req.body);
    const result = await productService.adjustStock(variantId, payload);

    return ApiResponse.ok(res, {
      data: result,
      message: `Stock ajustado: ${result.previousStock} → ${result.stock} unidades`
    });
  },

  async addImage(req, res) {
    const body = addImageSchema.parse(req.body ?? {});
    const image = await productService.addImage(req.validated.params.key, req.file, body);

    return ApiResponse.created(res, image, 'Imagen subida');
  },

  async removeImage(req, res) {
    const { imageId } = productImageParamSchema.parse(req.params);
    const image = await productService.removeImage(imageId);

    return ApiResponse.ok(res, { data: image, message: 'Imagen eliminada' });
  }
};
