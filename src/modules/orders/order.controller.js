import { ApiResponse } from '../../utils/ApiResponse.js';
import { orderService } from './order.service.js';

/**
 * Pedidos del propio cliente. Nada de esto acepta un `userId` del body: sale
 * siempre del token, que es la única fuente fiable de "quién eres".
 */
export const orderController = {
  /**
   * Crear pedido.
   *
   * La cabecera `Idempotency-Key` es opcional pero es lo que impide que un doble
   * clic o un reintento de red cree dos pedidos. Va en la CABECERA y no en el
   * body a propósito: no forma parte de la representación del recurso, la pone el
   * cliente HTTP y no debe guardarse como dato del pedido.
   */
  async checkout(req, res) {
    const result = await orderService.checkout(req.user.id, req.validated.body, {
      idempotencyKey: readIdempotencyKey(req)
    });

    // Un replay devuelve 200 y no 201: el recurso no se acaba de crear, ya
    // existía. Un 201 en un reintento haría que un cliente que reintenta por
    // prudencia creyera que tiene dos pedidos.
    return ApiResponse.ok(
      res,
      {
        data: result.order,
        message: result.replayed
          ? `El pedido ${result.order.orderNumber} ya estaba confirmado`
          : `Pedido ${result.order.orderNumber} confirmado`
      },
      result.replayed ? 200 : 201
    );
  },

  async list(req, res) {
    const { orders, meta } = await orderService.list(req.user.id, req.validated.query);

    return ApiResponse.ok(res, { data: orders, meta, message: `${meta.total} pedido(s)` });
  },

  async detail(req, res) {
    const order = await orderService.detail(req.user.id, req.validated.params.key);

    return ApiResponse.ok(res, { data: order });
  },

  async cancel(req, res) {
    const { key } = req.validated.params;
    const { reason } = req.validated.body;

    const order = await orderService.cancel(req.user.id, key, reason);

    return ApiResponse.ok(res, { data: order, message: `Pedido ${order.orderNumber} cancelado` });
  }
};

/**
 * Lee y sanea la clave de idempotencia.
 *
 * Solo se aceptan 8-64 caracteres de [A-Za-z0-9_-]. Sin ese filtro, la clave
 * acabaría en la base de datos tal cual venga, con basura arbitraria metida por
 * una cabecera; además el límite de 64 es el que impone la columna.
 *
 * Una clave con formato inválido se trata como si no hubiera cabecera, en vez de
 * devolver un 400. Es deliberado: es preferible un pago sin protección contra
 * duplicados a un cliente ajeno con una clave en base64 (+, /, =) al que se le
 * bloquea la compra por un detalle del formato. Quien manda la clave —nuestro
 * frontend— siempre genera una válida, así que la protección está garantizada en
 * el camino que importa.
 */
function readIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');

  if (!raw) return null;

  const key = raw.trim();

  return /^[A-Za-z0-9_-]{8,64}$/.test(key) ? key : null;
}
