import crypto from 'node:crypto';
import { prisma } from '../../config/database.js';
import { fromCents } from '../../utils/money.js';

/**
 * `OrderItem` guarda instantáneas (nombre, SKU, precio). El pedido es un
 * documento: cambiar el catálogo mañana no debe reescribir la historia de lo
 * que compró el cliente.
 */

const orderInclude = {
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { createdAt: 'asc' } },
  shipments: true,
  coupon: { select: { code: true, type: true } }
};

const orderSummarySelect = {
  id: true,
  orderNumber: true,
  status: true,
  placedAt: true,
  subtotal: true,
  discountTotal: true,
  shippingTotal: true,
  taxTotal: true,
  grandTotal: true,
  couponCode: true,
  _count: { select: { items: true } }
};

/**
 * Número de pedido legible: EXT-2026-1A2B3C4D.
 *
 * Por qué NO un contador autoincremental (`1`, `2`, `3`): dos checkouts
 * simultáneos leen el mismo "último número" y uno de los dos falla con un
 * conflicto de clave única. Si en cambio el número se deriva del id (un cuid
 * generado por nosotros antes de insertar), es único por construcción y no hay
 * carrera. Contra: los números no son correlativos, que para un cliente también
 * es una ventaja (no revela cuántas ventas hay).
 */
export function generateOrderNumber(id) {
  return `EXT-${new Date().getFullYear()}-${id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
}

export function findAddress(userId, addressId) {
  return prisma.address.findFirst({ where: { id: addressId, userId } });
}

export function listOrders(userId, { page, perPage }) {
  return prisma.$transaction([
    prisma.order.findMany({
      where: { userId },
      select: orderSummarySelect,
      orderBy: { placedAt: 'desc' },
      skip: (page - 1) * perPage,
      take: perPage
    }),
    prisma.order.count({ where: { userId } })
  ]);
}

/** Busca por número legible o por id. El filtro por `userId` va aquí: un pedido
 *  ajeno devuelve 404, nunca 403.
 *
 *  Se comparan las dos columnas a la vez en vez de adivinar por el formato de
 *  la clave: los ids no son siempre cuids (el checkout genera UUID) y un
 *  heurístico `length === 25` falla en silencio el día que se cambie. */
export function findOwnOrder(userId, key) {
  return prisma.order.findFirst({
    where: {
      userId,
      OR: [{ id: key }, { orderNumber: key.toUpperCase() }]
    },
    include: orderInclude
  });
}

export function findUser(userId) {
  return prisma.user.findUnique({ where: { id: userId }, select: { id: true, email: true, isActive: true } });
}

/**
 * Pedido creado con una clave de idempotencia concreta.
 *
 * Se usa para responder a la petición PERDEDORA de una carrera: cuando dos
 * checkouts con la misma clave chocan en el índice único, la segunda necesita
 * devolver el pedido que la primera creó en lugar de un 409. El filtro por
 * `userId` es obligatorio: la clave sola no identifica nada para otro usuario.
 */
export function findOrderByIdempotencyKey(userId, idempotencyKey) {
  if (!idempotencyKey) return null;

  return prisma.order.findFirst({
    where: { userId, idempotencyKey },
    include: orderInclude
  });
}

/** Datos de catálogo de una variante, para la instantánea del pedido. */
export function findVariantSnapshot(variantId) {
  return prisma.productVariant.findUnique({
    where: { id: variantId },
    include: {
      colorValue: true,
      sizeValue: true,
      product: {
        include: { images: { orderBy: { position: 'asc' }, take: 1 } }
      }
    }
  });
}

/**
 * Checkout completo en UNA transacción.
 *
 * Si algo falla a mitad (stock que se agotó entre la lectura y el INSERT, cupón
 * que se agotó, caída de MySQL), se deshace TODO: o existe el pedido con su
 * stock descontado, o no existe ninguno de los dos. Un pedido creado sin
 * descontar el stock o un stock descontado sin pedido son los dos fallos
 * Classics que hay que evitar a toda costa.
 */
export async function placeOrder({
  userId,
  email,
  phone,
  notes,
  priced,
  shippingAddress,
  billingAddress,
  couponId,
  couponCode,
  idempotencyKey,
  paymentMethod
}) {
  const orderId = crypto.randomUUID();

  return prisma.$transaction(async (tx) => {
    // 0. Reintento de la MISMA petición. Sin esto, un doble clic en "pagar" o un
    //    retry de red creaba un segundo pedido y descontaba el stock otra vez:
    //    el CAS del paso 1 evita el stock negativo, pero no el pedido duplicado.
    //    La garantía fuerte es el índice único (user_id, idempotency_key): si dos
    //    peticiones con la misma clave se cuelan por esta comprobación a la vez,
    //    la segunda revienta con P2002 y el service la traduce con la misma
    //    respuesta que el replay devuelve, sin crear nada.
    if (idempotencyKey) {
      const existing = await tx.order.findFirst({
        where: { userId, idempotencyKey },
        include: orderInclude
      });

      if (existing) return { order: existing, replayed: true };
    }

    // 1. Descontar stock con compare-and-swap: la condición `stock >= cantidad`
    //    garantiza que nadie se lleve más de lo que había, aunque dos personas
    //    compren la última unidad a la vez.
    for (const line of priced.lines) {
      const updated = await tx.productVariant.updateMany({
        where: { id: line.variantId, isActive: true, stock: { gte: line.quantity } },
        data: { stock: { decrement: line.quantity } }
      });

      if (updated.count === 0) {
        // Error con marca propia: el service lo traduce a 409 con el SKU.
        throw new Error(`OUT_OF_STOCK:${line.sku}`);
      }
    }

    // 2. Cabecera del pedido.
    await tx.order.create({
      data: {
        id: orderId,
        orderNumber: generateOrderNumber(orderId),
        userId,
        status: 'PENDING',
        email,
        phone: phone ?? null,
        subtotal: fromCents(priced.subtotalCents),
        discountTotal: fromCents(priced.discountCents),
        taxTotal: fromCents(priced.taxCents),
        shippingTotal: fromCents(priced.shippingCents),
        grandTotal: fromCents(priced.grandTotalCents),
        couponId: couponId ?? null,
        couponCode: couponCode ?? null,
        idempotencyKey: idempotencyKey ?? null,
        shippingAddress,
        billingAddress,
        notes: notes ?? null,
        items: {
          create: priced.lines.map((line) => ({
            productId: line.productId,
            variantId: line.variantId,
            productName: line.productName,
            variantName: line.variantName,
            sku: line.sku,
            imageUrl: line.imageUrl,
            unitPrice: fromCents(line.unitPriceCents),
            quantity: line.quantity,
            taxRate: line.taxRate,
            discountTotal: fromCents(line.discountCents),
            lineTotal: fromCents(line.lineTotalCents)
          }))
        },
        payments: {
          create: {
            method: paymentMethod,
            status: 'PENDING',
            amount: fromCents(priced.grandTotalCents),
            currency: 'EUR'
          }
        }
      }
    });

    // 3. El cupón se consume aquí, dentro de la misma transacción, con la misma
    //    protección condicional. Si se agotó el límite entre la validación y
    //    este momento, count = 0 y no se cobra el descuento.
    if (couponId) {
      const used = await tx.coupon.updateMany({
        where: {
          id: couponId,
          isActive: true,
          ...(priced.coupon?.usageLimit != null && { usedCount: { lt: priced.coupon.usageLimit } })
        },
        data: { usedCount: { increment: 1 } }
      });

      if (used.count === 0) throw new Error('COUPON_EXHAUSTED');

      // El increment de arriba deja bloqueada la fila del cupón (locks de
      // escritura en InnoDB), así que a partir de aquí nadie más puede
      // consumirlo hasta que esta transacción termine. Con el bloqueo
      // garantizado se puede volver a contar: si el usuario ya había alcanzado
      // `perUserLimit` con otro checkout simultáneo, esta es la compra que se
      // pasa de la raya, y se deshace entera.
      const userUses = await tx.order.count({ where: { userId, couponId } });

      if (userUses > priced.coupon.perUserLimit) throw new Error('COUPON_USER_LIMIT');
    }

    const order = await tx.order.findUnique({ where: { id: orderId }, include: orderInclude });

    // `replayed` le dice al service si esto es una compra nueva o la repetición
    // de una anterior: en el segundo caso el carrito ya se vació y no hay que
    // volver a vaciarlo (el usuario puede haber añadido cosas nuevas después).
    return { order, replayed: false };
  }, {
    // READ COMMITTED (MySQL por defecto es REPEATABLE READ) para que ese
    // recuento vea el pedido que acaba de confirmar un checkout concurrente:
    // con REPEATABLE READ el snapshot se fija en la primera lectura de la
    // transacción y devolvería el valor viejo, dejando pasar el abuso.
    isolationLevel: 'ReadCommitted'
  });
}

/**
 * Cancelación: devuelve el stock y libera el cupón, en la misma transacción.
 * Cancelar sin reponer el stock deja el almacén con un hueco fantasma.
 */
export async function cancelOrder(order, reason) {
  return prisma.$transaction(async (tx) => {
    // Reclamar la cancelación con compare-and-swap ANTES de tocar nada más.
    // Comprobar el estado fuera de la transacción deja pasar a dos
    // cancelaciones simultáneas del mismo pedido (doble clic, dos pestañas) y
    // las dos reponen stock: el almacén acaba con existencias fantasma. Aquí la
    // segunda transacción espera al lock de la fila y, al reevaluar el WHERE,
    // encuentra status = CANCELLED, no toca nada y Count = 0.
    const claimed = await tx.order.updateMany({
      where: { id: order.id, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: reason }
    });

    if (claimed.count === 0) throw new Error('ALREADY_CANCELLED');

    for (const item of order.items) {
      await tx.productVariant.update({
        where: { id: item.variantId },
        data: { stock: { increment: item.quantity } }
      });
    }

    if (order.couponId) {
      await tx.coupon.updateMany({
        where: { id: order.couponId },
        data: { usedCount: { decrement: 1 } }
      });
    }

    await tx.payment.updateMany({
      where: { orderId: order.id, status: 'PENDING' },
      data: { status: 'FAILED', failureReason: 'Pedido cancelado por el cliente' }
    });

    return tx.order.findUnique({ where: { id: order.id }, include: orderInclude });
  });
}
