import { ApiResponse } from '../../utils/ApiResponse.js';
import { cartService } from './cart.service.js';

/**
 * Todo el carrito es del usuario autenticado: no hay carrito invitado, así que
 * ninguna consulta necesita filtrar por propietario. El service recibe
 * `req.user.id` (del token verificado), nunca un id del body.
 */
export const cartController = {
  async get(req, res) {
    const cart = await cartService.get(req.user.id);

    return ApiResponse.ok(res, { data: cart });
  },

  async addItem(req, res) {
    const { item } = await cartService.addItem(req.user.id, req.validated.body);

    return ApiResponse.created(res, item, `${item.quantity} unidad(es) añadidas al carrito`);
  },

  async updateItem(req, res) {
    const { itemId } = req.validated.params;
    const { quantity } = req.validated.body;

    const { cart } = await cartService.updateItem(req.user.id, itemId, quantity);

    return ApiResponse.ok(res, { data: cart, message: 'Cantidad actualizada' });
  },

  async removeItem(req, res) {
    const { itemId } = req.validated.params;

    const { cart } = await cartService.removeItem(req.user.id, itemId);

    return ApiResponse.ok(res, { data: cart, message: 'Línea eliminada' });
  },

  async clear(req, res) {
    const { cart } = await cartService.clear(req.user.id);

    return ApiResponse.ok(res, { data: cart, message: 'Carrito vacío' });
  },

  async applyCoupon(req, res) {
    const { code } = req.validated.body;
    const { cart } = await cartService.applyCoupon(req.user.id, code);

    // El cupón viaja dentro de `data` (cart.coupon) y no suelto junto a `data`:
    // el sobre de la respuesta es fijo para todo el cliente HTTP.
    return ApiResponse.ok(res, { data: cart, message: `Cupón ${code} aplicado` });
  },

  /**
   * Quitar el cupón es local: el código vive en el cliente, no en la tabla
   * `carts`. Por eso este endpoint no toca la base de datos.
   */
  async removeCoupon(req, res) {
    const cart = await cartService.get(req.user.id);

    return ApiResponse.ok(res, { data: cart, message: 'Cupón retirado' });
  }
};
