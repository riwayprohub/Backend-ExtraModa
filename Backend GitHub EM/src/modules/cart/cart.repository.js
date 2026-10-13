import { prisma } from '../../config/database.js';

/**
 * `Cart.userId` es único: un carrito por usuario, sin carritos invitados
 * (no hay columna para ellos en el schema). El carrito se crea la primera vez
 * que se toca, y por eso casi todo método acaba en `ensureCart`.
 */

const itemInclude = {
  product: {
    include: {
      images: { orderBy: { position: 'asc' }, take: 1 }
    }
  },
  variant: {
    include: {
      colorValue: true,
      sizeValue: true
    }
  }
};

const cartInclude = {
  items: {
    include: itemInclude,
    orderBy: { createdAt: 'asc' }
  }
};

export function findCart(userId) {
  return prisma.cart.findUnique({ where: { userId }, include: cartInclude });
}

/**
 * Un carrito por usuario (`userId` es único). Se crea bajo demanda: un usuario
 * que solo navega no tiene fila en `carts`.
 *
 * El P2002 es esperado, no un fallo: dos peticiones simultáneas de un usuario
 * sin carrito (doble clic en "añadir", o dos pestañas) intentarán crear el
 * mismo carrito a la vez, porque el `upsert` de Prisma en MySQL es SELECT +
 * INSERT y no un INSERT atómico. Quien pierde el INSERT simplemente vuelve a
 * leer el carrito que el otro acaba de crear.
 */
export async function ensureCart(userId) {
  try {
    return await prisma.cart.upsert({
      where: { userId },
      create: { userId },
      update: {},
      include: cartInclude
    });
  } catch (error) {
    if (error.code === 'P2002') return prisma.cart.findUniqueOrThrow({ where: { userId }, include: cartInclude });
    throw error;
  }
}

export function findVariant(variantId) {
  return prisma.productVariant.findUnique({
    where: { id: variantId },
    include: { product: true }
  });
}

export function findItem(itemId) {
  return prisma.cartItem.findUnique({
    where: { id: itemId },
    include: { cart: true }
  });
}

/**
 * Añadir dos veces la misma variante NO crea dos líneas: el índice único
 * (cartId, variantId) obliga a sumar la cantidad. Por eso primero se busca la
 * línea existente en lugar de confiar en un `create`.
 */
export async function upsertItem({ cartId, productId, variantId, quantity, unitPrice }) {
  const where = { cartId_variantId: { cartId, variantId } };
  const update = {
    quantity: { increment: quantity },
    // El snapshot se refresca con el precio actual: el carrito muestra
    // siempre lo que se va a cobrar hoy.
    unitPrice
  };

  try {
    return await prisma.cartItem.upsert({
      where,
      create: { cartId, productId, variantId, quantity, unitPrice },
      update,
      include: itemInclude
    });
  } catch (error) {
    // En MySQL, `upsert` de Prisma es un SELECT seguido de INSERT/UPDATE, no
    // un INSERT ... ON DUPLICATE KEY. Dos "añadir al carrito" a la vez (doble
    // clic, o el retry del frontend) llegan los dos al INSERT y uno revienta
    // con P2002. En vez de devolver un 500, se reintenta: el reintento ya
    // encuentra la línea y suma las unidades, que es lo que quería el usuario.
    if (error.code === 'P2002') {
      return prisma.cartItem.update({ where, data: update, include: itemInclude });
    }
    throw error;
  }
}

export function setItemQuantity(itemId, quantity) {
  return prisma.cartItem.update({
    where: { id: itemId },
    data: { quantity },
    include: itemInclude
  });
}

export function deleteItem(itemId) {
  return prisma.cartItem.delete({ where: { id: itemId } });
}

export function clearItems(cartId) {
  return prisma.cartItem.deleteMany({ where: { cartId } });
}

export function findCouponByCode(code) {
  return prisma.coupon.findUnique({
    where: { code },
    include: { products: { select: { productId: true } } }
  });
}

/** Cuántas veces ha usado este usuario este cupón (límite por usuario). */
export function countCouponUses(userId, couponId) {
  return prisma.order.count({ where: { userId, couponId } });
}
