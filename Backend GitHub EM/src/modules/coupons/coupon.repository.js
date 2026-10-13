import { prisma } from '../../config/database.js';

/**
 * Única capa que habla con la base de datos para cupones.
 * No conoce req/res ni mensajes de error: devuelve datos o lanza.
 */

const includeStats = {
  _count: { select: { orders: true } },
  products: { select: { productId: true, product: { select: { id: true, name: true, slug: true } } } }
};

export function findMany({ where, page, perPage }) {
  const skip = (page - 1) * perPage;

  return Promise.all([
    prisma.coupon.count({ where }),
    prisma.coupon.findMany({
      where,
      skip,
      take: perPage,
      orderBy: { createdAt: 'desc' },
      include: includeStats
    })
  ]).then(([total, items]) => ({ items, total }));
}

export function findById(id) {
  return prisma.coupon.findUnique({ where: { id }, include: includeStats });
}

/**
 * El código se normaliza a mayúsculas al guardar, y la colación por defecto de
 * MySQL (utf8mb4_general_ci / _0900_ai_ci) ya compara sin distinguir
 * mayúsculas: NO hace falta `mode: 'insensitive'`, que es exclusivo de
 * PostgreSQL y aquí rompe la query con "Unknown argument `mode`".
 */
export function codeExists(code, excludeId) {
  return prisma.coupon
    .findFirst({ where: { code, ...(excludeId && { id: { not: excludeId } }) }, select: { id: true } })
    .then(Boolean);
}

/**
 * Creación con sus productos vinculados en una transacción. Un cupón
 * restringido (`appliesToAllProducts: false`) solo existe a través de sus
 * filas en `coupon_products`: crearlo sin ellas daría un cupón que no
 * descuenta nada.
 */
export function create(data) {
  const { productIds, ...coupon } = data;

  return prisma.coupon.create({
    data: {
      ...coupon,
      ...(productIds?.length && {
        products: { create: productIds.map((productId) => ({ productId })) }
      })
    },
    include: includeStats
  });
}

/**
 * Actualización. Si viene `productIds` se REEMPLAZA la lista completa: un
 * PATCH parcial que solo añadiera productos dejaría en la BD enlaces que el
 * administrador ya quitó desde el panel.
 */
export function update(id, data) {
  const { productIds, ...coupon } = data;

  return prisma.$transaction(async (tx) => {
    if (productIds) {
      await tx.couponProduct.deleteMany({ where: { couponId: id } });
    }

    return tx.coupon.update({
      where: { id },
      data: {
        ...coupon,
        ...(productIds?.length && {
          products: { create: productIds.map((productId) => ({ productId })) }
        })
      },
      include: includeStats
    });
  });
}

/** Baja lógica: se conserva el cupón para no romper pedidos que lo citan. */
export function deactivate(id) {
  return prisma.coupon.update({ where: { id }, data: { isActive: false }, include: includeStats });
}

/**
 * Borrado duro. Los pedidos que lo usaron NO se rompen: guardan una copia del
 * código (`order.couponCode`) y la relación es onDelete: SetNull.
 */
export function remove(id) {
  return prisma.coupon.delete({ where: { id } });
}

export function countOrders(id) {
  return prisma.order.count({ where: { couponId: id } });
}

/** Los productos existen de verdad: un id inventado dejaría el cupón inutilizable. */
export function findExistingProducts(ids) {
  return prisma.product
    .findMany({ where: { id: { in: ids } }, select: { id: true } })
    .then((rows) => new Set(rows.map((row) => row.id)));
}
