import { ApiResponse } from '../../utils/ApiResponse.js';
import { couponService } from './coupon.service.js';
import {
  createCouponSchema,
  updateCouponSchema,
  couponIdParamSchema,
  listCouponsQuerySchema
} from './coupon.schema.js';

/**
 * Panel de promociones. Todos los endpoints son de ADMIN/EDITOR: la lista
 * completa de cupones (incluidos los desactivados y su contador de usos) no
 * es información pública.
 */
export const couponController = {
  async list(req, res) {
    const query = listCouponsQuerySchema.parse(req.query);
    const data = await couponService.list(query);

    return ApiResponse.paginated(res, { items: data.items, total: data.total, page: data.page, perPage: data.perPage });
  },

  async create(req, res) {
    const input = createCouponSchema.parse(req.body);
    const coupon = await couponService.create(input);

    return ApiResponse.created(res, coupon, `Cupón "${coupon.code}" creado`);
  },

  async update(req, res) {
    const input = updateCouponSchema.parse(req.body);
    const { id } = couponIdParamSchema.parse(req.params);
    const coupon = await couponService.update(id, input);

    return ApiResponse.ok(res, { data: coupon, message: 'Cupón actualizado' });
  },

  async remove(req, res) {
    const { id } = couponIdParamSchema.parse(req.params);
    const result = await couponService.remove(id);

    // El cliente solo lee `data` (el mensaje del sobre se descarta al
    // desenvolver), así que la distinción borrado/desactivado viaja en el
    // propio dato: quien llama tiene que poder explicar qué ha pasado.
    return ApiResponse.ok(res, {
      data: { id, deleted: result.deleted },
      message: result.message
    });
  }
};
