import { AppError } from '../../utils/AppError.js';
import { cartService } from '../cart/cart.service.js';
import { toOrderSummary, toOrderDetail } from './order.mapper.js';
import * as repository from './order.repository.js';

/**
 * Pedidos.
 *
 * El checkout NO confía en nada de lo que venga del cliente: precios, IVA,
 * descuentos y disponibilidad se recalculan desde la base de datos. El carrito
 * es una sugerencia; la verdad está en `product_variants.stock`.
 */

export const orderService = {
  /**
   * @param userId  Del token, nunca del body.
   * @param input   Body ya validado con zod.
   * @param options.idempotencyKey  Cabecera `Idempotency-Key` ya saneada.
   */
  async checkout(userId, input, { idempotencyKey = null } = {}) {
    const user = await repository.findUser(userId);
    if (!user?.isActive) throw AppError.forbidden('Tu cuenta está deshabilitada');

    // El replay se resuelve ANTES de mirar el carrito, no después. El primer
    // intento lo dejó vacío, así que si la clave se consultara más abajo el
    // reintento moriría con "Tu carrito está vacío" sin llegar a comprobarla: el
    // cliente vería un error en un pago que en realidad sí se hizo.
    if (idempotencyKey) {
      const previous = await repository.findOrderByIdempotencyKey(userId, idempotencyKey);
      if (previous) {
        const { cart } = await cartService.get(userId);
        return { order: toOrderDetail(previous), cart, replayed: true };
      }
    }

    const { priced } = await cartService.quoteFor(userId, input.couponCode);

    if (priced.lines.length === 0) {
      throw AppError.badRequest('Tu carrito está vacío');
    }

    const shippingAddress = await resolveAddress(userId, input);
    const billingAddress = input.billingSameAsShipping ? shippingAddress : input.billingAddress;

    // Datos de la instantánea: en este punto ya sabemos qué se compra, así que
    // se puede ir a por los nombres y la foto antes de escribir el pedido.
    const lines = await withProductSnapshot(priced.lines);

    // El `try` solo envuelve la escritura del pedido, NUNCA el vaciado del
    // carrito. Si `clear` fallara dentro, el cliente recibiría un error de un
    // pedido que ya está confirmado, y al reintentar crearía un segundo pedido:
    // el peor resultado posible en un checkout.
    const { order, replayed } = await placeOrderSafely(
      {
        userId,
        email: user.email,
        phone: input.phone,
        notes: input.notes,
        priced: { ...priced, lines },
        shippingAddress,
        billingAddress,
        couponId: priced.coupon?.id ?? null,
        couponCode: priced.coupon?.code ?? null,
        idempotencyKey,
        paymentMethod: input.paymentMethod
      },
      userId,
      idempotencyKey
    );

    // El carrito se vacía DESPUÉS del pedido y FUERA de la transacción: si
    // fallara, el pedido ya existe pero el cliente conserva su carrito y puede
    // reintentar, que es infinitamente preferible a un carrito vacío sin pedido.
    // En un replay no se toca: el carrito ya se vació con el primer intento y
    // puede contener productos que el usuario ha añadido después.
    const { cart } = replayed ? { cart: await cartService.get(userId) } : await cartService.clear(userId);

    return { order: toOrderDetail(order), cart, replayed };
  },

  async list(userId, { page, perPage }) {
    const [orders, total] = await repository.listOrders(userId, { page, perPage });

    return {
      orders: orders.map(toOrderSummary),
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.max(1, Math.ceil(total / perPage))
      }
    };
  },

  async detail(userId, key) {
    const order = await repository.findOwnOrder(userId, key);

    if (!order) {
      // 404 también para "existe pero es de otro": no confirmamos la existencia
      // de pedidos ajenos.
      throw AppError.notFound(`No hemos encontrado el pedido "${key}"`);
    }

    return toOrderDetail(order);
  },

  /**
   * Solo se puede cancelar lo que aún no se ha pagado. Un pedido pagado exige
   * una devolución, que es otro flujo (y otro endpoint).
   */
  async cancel(userId, key, reason) {
    const order = await repository.findOwnOrder(userId, key);

    if (!order) throw AppError.notFound(`No hemos encontrado el pedido "${key}"`);

    if (order.status === 'CANCELLED') {
      throw AppError.conflict('Este pedido ya estaba cancelado');
    }
    if (order.status !== 'PENDING') {
      throw AppError.conflict(
        `Un pedido en estado ${order.status} ya no se puede cancelar por el cliente: ` +
          'si ya está pagado hay que solicitar una devolución',
        { status: order.status }
      );
    }

    let cancelled;
    try {
      cancelled = await repository.cancelOrder(order, reason);
    } catch (error) {
      // Perdimos la carrera contra otra cancelación simultánea: el pedido ya
      // quedó CANCELLED y el stock ya se repuso una vez. 409, no 500.
      if (error.message === 'ALREADY_CANCELLED') {
        throw AppError.conflict('Este pedido ya estaba cancelado');
      }
      throw error;
    }

    return toOrderDetail(cancelled);
  }
};

// ── Auxiliares ────────────────────────────────────────────────────────────────

/**
 * Escribe el pedido traduciendo los fallos internos a errores HTTP.
 *
 * Aísla el `try` en su propia función para que quede obvio qué operaciones
 * comparten la traducción de errores y cuáles no: el vaciado del carrito, que va
 * fuera, nunca debe pasar por aquí.
 *
 * `userId` e `idempotencyKey` se pasan aparte (y no se leen de `input`) solo
 * para poder recuperar el pedido ganador cuando dos peticiones con la misma
 * clave chocan en el índice único.
 */
async function placeOrderSafely(input, userId, idempotencyKey) {
  try {
    return await repository.placeOrder(input);
  } catch (error) {
    const translated = translateCheckoutError(error);

    // Carrera perdida contra otra petición con la misma clave: el pedido existe
    // y es este mismo. Se devuelve ESE pedido en lugar de un error, que es lo que
    // espera quien reintenta un pago por si la primera respuesta se perdió.
    // `AppError.conflict(msg, details)` mete el código en `details`, no en
    // `error.code` (que siempre es 'CONFLICT'), así que se lee de ahí.
    if (translated.details?.code === 'IDEMPOTENT_REPLAY') {
      const existing = await repository.findOrderByIdempotencyKey(userId, idempotencyKey);

      if (existing) return { order: existing, replayed: true };
    }

    throw translated;
  }
}

async function resolveAddress(userId, { addressId, shippingAddress }) {
  if (!addressId) return shippingAddress;

  const address = await repository.findAddress(userId, addressId);

  if (!address) throw AppError.notFound('Esa dirección no está en tu cuenta');

  // Copia explícita: el pedido guarda la dirección tal y como se usó ese día,
  // sin los campos internos de la tabla `addresses` (labels, isDefault...).
  return {
    firstName: address.firstName,
    lastName: address.lastName,
    company: address.company,
    line1: address.line1,
    line2: address.line2,
    city: address.city,
    province: address.province,
    postalCode: address.postalCode,
    countryCode: address.countryCode,
    phone: address.phone
  };
}

/** Añade nombre, SKU, foto y nombre de variante a cada línea del presupuesto. */
async function withProductSnapshot(lines) {
  const details = await Promise.all(
    lines.map((line) => repository.findVariantSnapshot(line.variantId))
  );

  return lines.map((line, index) => {
    const detail = details[index];
    if (!detail) throw AppError.notFound(`La variante ${line.variantId} ya no existe`);

    return {
      ...line,
      productName: detail.product.name,
      variantName:
        [detail.colorValue?.label, detail.sizeValue?.label].filter(Boolean).join(' / ') || null,
      sku: detail.sku,
      imageUrl: detail.product.images[0]?.url ?? null,
      taxRate: Number(detail.product.taxRate)
    };
  });
}

/**
 * Traduce los fallos internos de la transacción a errores HTTP con mensaje
 * útil. `AppError` ya es una clase, así que si ya es de ese tipo se propaga
 * tal cual.
 */
function translateCheckoutError(error) {
  if (error instanceof AppError) return error;
  if (error.code === 'P2002') {
    // La UNICA clave única que puede chocar aquí es (user_id, idempotency_key):
    // significa que otra petición con la misma clave se adelantó por unos
    // milisegundos y ya creó el pedido. Se trata como un replay, no como un
    // error: el cliente pidió el mismo pago dos veces y hay que darle UN pedido.
    // Cualquier otra P2002 (el número de pedido, que es aleatorio) sí es un
    // conflicto real y se devuelve como 409 para que reintente.
    if (String(error.meta?.target ?? '').includes('idempotency')) {
      return AppError.conflict('Ese checkout ya se está procesando', {
        code: 'IDEMPOTENT_REPLAY'
      });
    }

    return AppError.duplicate('Ese número de pedido ya existe. Inténtalo de nuevo.', {
      code: 'ORDER_NUMBER_CONFLICT'
    });
  }
  if (error.message?.startsWith('OUT_OF_STOCK:')) {
    const sku = error.message.split(':')[1];
    return AppError.conflict(`Se ha agotado el stock de ${sku} mientras comprabas`, {
      code: 'OUT_OF_STOCK',
      sku
    });
  }
  if (error.message === 'COUPON_EXHAUSTED') {
    return AppError.conflict('Ese cupón se ha agotado mientras comprabas', {
      code: 'COUPON_EXHAUSTED'
    });
  }
  if (error.message === 'COUPON_USER_LIMIT') {
    return AppError.conflict('Ya has usado ese cupón el número máximo de veces permitido', {
      code: 'COUPON_LIMIT_REACHED'
    });
  }
  return error;
}
