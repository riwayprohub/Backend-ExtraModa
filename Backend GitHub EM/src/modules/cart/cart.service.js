import { AppError } from '../../utils/AppError.js';
import { quote } from '../../utils/pricing.js';
import { fromCents, toCents } from '../../utils/money.js';
import * as repository from './cart.repository.js';
import { MAX_LINE_QUANTITY } from './cart.schema.js';

/**
 * Carrito de compra.
 *
 * Decisión clave: el carrito NO reserva stock. Reservar al añadir evita la
 * decepción en el checkout, pero obliga a Caducar carritos (un cliente que
 * añade 10 unidades y se va bloquea el producto para el resto). El stock se
 * descuenta en el checkout, que es donde se confirma la compra.
 */

export const cartService = {
  async get(userId) {
    const cart = await repository.ensureCart(userId);
    return buildCartDto(cart);
  },

  async addItem(userId, { variantId, quantity }) {
    const variant = await repository.findVariant(variantId);

    if (!variant || !variant.isActive || variant.product.status !== 'ACTIVE') {
      throw AppError.notFound('Ese producto no está disponible');
    }

    const cart = await repository.ensureCart(userId);
    const existing = cart.items.find((item) => item.variantId === variantId);
    const wanted = (existing?.quantity ?? 0) + quantity;

    const available = Math.max(0, variant.stock - variant.reservedStock);

    if (available === 0) {
      throw AppError.conflict('Ese producto está agotado', { available: 0 });
    }
    if (wanted > available) {
      throw AppError.conflict(
        `Solo quedan ${available} unidad(es) disponibles`,
        { available, requested: wanted }
      );
    }
    if (wanted > MAX_LINE_QUANTITY) {
      throw AppError.badRequest(
        `Máximo ${MAX_LINE_QUANTITY} unidades por variante`,
        { max: MAX_LINE_QUANTITY }
      );
    }

    const item = await repository.upsertItem({
      cartId: cart.id,
      productId: variant.productId,
      variantId,
      quantity,
      unitPrice: currentVariantPrice(variant)
    });

    return { item: toItemDto(item), cart: await this.get(userId) };
  },

  async updateItem(userId, itemId, quantity) {
    const item = await ownItem(userId, itemId);
    const variant = await repository.findVariant(item.variantId);
    const available = Math.max(0, variant.stock - variant.reservedStock);

    if (quantity > available) {
      throw AppError.conflict(`Solo quedan ${available} unidad(es) disponibles`, {
        available,
        requested: quantity
      });
    }

    await repository.setItemQuantity(itemId, quantity);

    return { cart: await this.get(userId) };
  },

  async removeItem(userId, itemId) {
    await ownItem(userId, itemId);
    await repository.deleteItem(itemId);

    return { cart: await this.get(userId) };
  },

  async clear(userId) {
    const cart = await repository.ensureCart(userId);
    await repository.clearItems(cart.id);

    return { cart: await this.get(userId) };
  },

  /**
   * Aplica un cupón y devuelve el carrito recalculado.
   * El cupón NO se guarda en la base de datos: vive en el cliente (`localStorage`
   * o cookie) y se revalida en cada petición. Guardarlo obligaría a duplicar
   * reglas en la tabla `carts` y a limpiar cupones caducados a diario.
   */
  async applyCoupon(userId, code) {
    const coupon = await repository.findCouponByCode(code);

    if (!coupon) throw AppError.notFound('Ese código de descuento no existe');

    const cart = await repository.ensureCart(userId);
    const uses = await repository.countCouponUses(userId, coupon.id);

    // quote() lanza AppError con el motivo exacto si el cupón no es válido.
    const priced = quote(toQuoteLines(cart), { coupon, userUses: uses });

    return {
      cart: { ...toCartDto(cart, priced), coupon: toCouponDto(coupon, priced.discountCents) }
    };
  },

  /**
   * Presupuesto del carrito. Lo reutiliza el checkout: es exactamente el mismo
   * cálculo, no una aproximación.
   */
  async quoteFor(userId, couponCode, { orderOnly = false } = {}) {
    const cart = await repository.ensureCart(userId);
    const lines = toQuoteLines(cart);

    let coupon = null;
    let uses = 0;

    if (couponCode) {
      coupon = await repository.findCouponByCode(couponCode);
      if (!coupon) throw AppError.notFound(`El cupón "${couponCode}" no existe`);
      uses = await repository.countCouponUses(userId, coupon.id);
    }

    return { cart, priced: quote(lines, { coupon, userUses: uses }), coupon, orderOnly };
  }
};

// ── Auxiliares ────────────────────────────────────────────────────────────────

/**
 * Una línea del carrito solo es comprable si su producto sigue activo. Un
 * producto archivado deja de estar en el carrito, pero no se borra solo: el
 * cliente decide.
 */
function toQuoteLines(cart) {
  return cart.items
    .filter((item) => item.product.status === 'ACTIVE' && item.variant.isActive)
    .map((item) => ({
      itemId: item.id,
      variantId: item.variantId,
      productId: item.productId,
      quantity: item.quantity,
      unitPrice: currentVariantPrice(item.variant),
      taxRate: Number(item.product.taxRate)
    }));
}

/** Precio efectivo actual de la variante (oferta si la hay). */
function currentVariantPrice(variant) {
  const sale = variant.salePrice === null ? null : Number(variant.salePrice);
  const base = Number(variant.price);
  return sale !== null && sale < base ? sale : base;
}

/** Verifica que la línea existe Y es de este usuario (evita fugas entre cuentas). */
async function ownItem(userId, itemId) {
  const item = await repository.findItem(itemId);

  if (!item || item.cart.userId !== userId) {
    // 404 y no 403: no revelamos que esa línea existe en el carrito de otro.
    throw AppError.notFound('Esa línea no está en tu carrito');
  }
  return item;
}

function toItemDto(item) {
  const price = currentVariantPrice(item.variant);
  const snapshot = Number(item.unitPrice);

  return {
    id: item.id,
    quantity: item.quantity,
    unitPrice: price,
    // El cliente puede tener la cantidad en el carrito y el precio haber
    // cambiado desde entonces; hay que avisar, no cobrar a escondidas.
    priceChangedSinceAdded: snapshot !== price,
    previousUnitPrice: snapshot !== price ? snapshot : null,
    lineTotal: fromCents(toCents(price) * item.quantity),
    variant: {
      id: item.variant.id,
      sku: item.variant.sku,
      color: item.variant.colorValue?.label ?? null,
      size: item.variant.sizeValue?.label ?? null,
      stockAvailable: Math.max(0, item.variant.stock - item.variant.reservedStock)
    },
    product: {
      id: item.product.id,
      slug: item.product.slug,
      name: item.product.name,
      image: item.product.images[0]?.url ?? null
    }
  };
}

function toCartDto(cart, priced = null) {
  const items = cart.items.map(toItemDto);

  return {
    id: cart.id,
    items,
    itemCount: items.reduce((total, item) => total + item.quantity, 0),
    totals: toTotalsDto(priced),
    updatedAt: cart.updatedAt
  };
}

/**
 * DTO del carrito CON totales. Un carrito vacío no cobra envío: si no, la
 * pantalla de carrito en blanco muestra "14,19 €" y parece un error.
 */
function buildCartDto(cart) {
  return toCartDto(cart, cart.items.length ? quote(toQuoteLines(cart)) : null);
}

function toTotalsDto(priced) {
  if (!priced) {
    return {
      subtotal: 0,
      itemsSubtotal: 0,
      discount: 0,
      shipping: 0,
      tax: 0,
      total: 0,
      freeShipping: false
    };
  }

  return {
    subtotal: fromCents(priced.subtotalCents),
    /**
     * Importe YA descontado. Se manda explícito para que el frontend pueda
     * mostrarlo sin recalcularlo: lo que se paga es este importe más envío e
     * IVA, no `subtotal`.
     */
    itemsSubtotal: fromCents(priced.subtotalCents - priced.discountCents),
    discount: fromCents(priced.discountCents),
    shipping: fromCents(priced.shippingCents),
    tax: fromCents(priced.taxCents),
    total: fromCents(priced.grandTotalCents),
    freeShipping: priced.freeShipping
  };
}

function toCouponDto(coupon, discountCents) {
  return {
    code: coupon.code,
    description: coupon.description,
    type: coupon.type,
    value: Number(coupon.value),
    discount: fromCents(discountCents)
  };
}

export { buildCartDto, toCartDto, toQuoteLines, currentVariantPrice };
