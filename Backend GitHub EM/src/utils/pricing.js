import { toCents, percentOf, sum, distribute } from './money.js';
import { AppError } from './AppError.js';

/**
 * Reglas de envío. En un proyecto real esto vendría de una tabla de zonas en
 * la BD; aquí una constante explícita es más honesta que un `4.90` escondido
 * en el controlador.
 *
 * NO existe envío gratuito por importe de pedido: la tienda no promete
 * umbrales. El envío solo baja a 0 con un cupón de tipo FREE_SHIPPING.
 */
export const SHIPPING = {
  flatRateCents: 490 // 4,90 Bs, siempre que haya productos en el carrito
};

/**
 * Presupuesto de un carrito o de un pedido.
 *
 * Es la MISMA función para el carrito y para el checkout, a propósito: si el
 * total que ve el cliente antes de pagar y el que se cobra no salen del mismo
 * sitio, el primero es decoración.
 *
 * Devuelve TODO en céntimos. Cada línea lleva su reparto de descuento y su
 * IVA para que `OrderItem` guarde exactamente lo que se cobró.
 *
 * @param lines [{ variantId, productId, quantity, unitPrice, taxRate }] unitPrice en euros
 */
export function quote(lines, { coupon = null, userUses = 0, now = new Date() } = {}) {
  // Nada que presupuestar: un carrito vacío no cobra envío ni IVA. Sin este
  // return, un carrito recién creado mostraría "14,19 €" de portes.
  if (lines.length === 0) {
    return {
      lines: [],
      coupon: null,
      itemCount: 0,
      subtotalCents: 0,
      discountCents: 0,
      freeShipping: false,
      shippingCents: 0,
      taxCents: 0,
      grandTotalCents: 0
    };
  }

  const priced = lines.map((line) => {
    const unitPriceCents = toCents(line.unitPrice);
    const quantity = line.quantity;
    const grossCents = unitPriceCents * quantity;

    return {
      ...line,
      unitPriceCents,
      quantity,
      grossCents
    };
  });

  const subtotalCents = sum(priced.map((line) => line.grossCents));

  const couponResult = coupon
    ? validateCoupon(coupon, { lines: priced, userUses, now })
    : { discountCents: 0, freeShipping: false, coupon: null, eligibleIndexes: null };

  // El cupón se reparte entre las líneas en proporción a su importe. Sin este
  // reparto, el IVA de cada línea sería distinto según por dónde caiga el
  // descuento y la suma no cuadraría con el total.
  //
  // Solo entre las líneas ELEGIBLES: un cupón restringido a un producto no puede
  // descontar sobre los demás. El reparto se hace sobre la lista elegible y
  // luego se coloca en su posición, en vez de pasar los pesos con ceros: `distribute`
  // reparte el céntimo sobrante por resto, y un peso de 0 empata en resto con
  // una línea cuyo descuento sale exacto, así que ese céntimo podría acabar en
  // una línea que no cumple la restricción.
  const eligibleIndexes = couponResult.eligibleIndexes ?? priced.map((_, index) => index);
  const eligibleShares = distribute(
    couponResult.discountCents,
    eligibleIndexes.map((index) => priced[index].grossCents)
  );
  const discountShares = priced.map(() => 0);
  eligibleIndexes.forEach((lineIndex, position) => {
    discountShares[lineIndex] = eligibleShares[position];
  });

  const withShares = priced.map((line, index) => {
    const taxableCents = line.grossCents - discountShares[index];

    return {
      ...line,
      lineTotalCents: taxableCents,
      discountCents: discountShares[index],
      // `taxRate` viene de la BD como fracción (0.21 = 21 %), y percentOf
      // espera un porcentaje (21). De ahí el *100.
      taxCents: percentOf(taxableCents, Number(line.taxRate) * 100)
    };
  });

  const discountCents = couponResult.discountCents;
  const itemsSubtotalCents = subtotalCents - discountCents;

  // Sin umbral de envío gratuito: el envío se cobra siempre salvo cupón
  // FREE_SHIPPING. Antes aquí había un `>= 59,90 €` que la tienda ya no
  // práctica, y prometerlo en el carrito sin cumplirlo es lo que se evitaba.
  const freeShipping = couponResult.freeShipping;

  // En España el transporte también lleva IVA: se calcula sobre el importe de
  // los productos ya descontados y se le suma al total.
  const shippingCents = freeShipping ? 0 : SHIPPING.flatRateCents;
  const taxCents = sum(withShares.map((line) => line.taxCents)) + percentOf(shippingCents, 21);

  return {
    lines: withShares,
    coupon: couponResult.coupon,
    itemCount: sum(withShares.map((line) => line.quantity)),
    subtotalCents,
    discountCents,
    freeShipping,
    shippingCents,
    taxCents,
    grandTotalCents: itemsSubtotalCents + shippingCents + taxCents
  };
}

/**
 * Valida un cupón y calcula su descuento en céntimos.
 * Cada rechazo tiene su propio mensaje: "cupón no válido" para todo hace que el
 * cliente pruebe cupones a ciegas y llame al teléfono.
 *
 * Recibe las líneas YA presupuestadas (`grossCents`) porque un cupón restringido
 * se calcula sobre el subtotal de los productos elegibles, no sobre el carrito
 * entero: si no, un 50 % sobre "solo ESD" aplicaría el 50 % a los productos que
 * el cupón excluye y descontaría más de lo que el cliente puede usar.
 *
 * Devuelve además `eligibleIndexes`: las posiciones sobre las que se reparte el
 * descuento, para que el reparto tampoco toque lo no elegible.
 */
export function validateCoupon(coupon, { lines, userUses = 0, now = new Date() }) {
  const reject = (message) => {
    throw AppError.badRequest(message, { code: 'COUPON_INVALID' });
  };

  if (!coupon.isActive) reject('Este cupón ya no está activo');
  if (coupon.startsAt && coupon.startsAt > now) reject('Este cupón todavía no está disponible');
  if (coupon.expiresAt && coupon.expiresAt <= now) reject('Este cupón ha caducado');

  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) {
    reject('Este cupón ha alcanzado su límite de usos');
  }
  if (userUses >= coupon.perUserLimit) {
    reject('Ya has usado este cupón el número máximo de veces permitido');
  }

  const eligibleIndexes = eligibleLineIndexes(coupon, lines);
  if (eligibleIndexes.length === 0) {
    reject('Este cupón no se puede aplicar a los productos de tu carrito');
  }
  const eligibleSubtotalCents = sum(eligibleIndexes.map((index) => lines[index].grossCents));

  // El mínimo también se mide sobre lo elegible: un cupón de "pedido mínimo
  // 150 € en chanclas" no debe aceptarse por 100 € de chanclas y 200 € de otro
  // producto que el cupón no cubre.
  const minSubtotalCents = coupon.minSubtotal === null || coupon.minSubtotal === undefined ? 0 : toCents(coupon.minSubtotal);
  if (eligibleSubtotalCents < minSubtotalCents) {
    reject(`Este cupón necesita un pedido mínimo de ${(minSubtotalCents / 100).toFixed(2)} €`);
  }

  if (coupon.type === 'FREE_SHIPPING') {
    return { discountCents: 0, freeShipping: true, coupon, eligibleIndexes };
  }

  // `== null` a propósito: los cupones sin techo traen `null` desde Prisma y
  // `undefined` cuando el objeto se construye a mano. Con `=== null` el
  // `undefined` pasaba el filtro y `toCents(undefined)` devolvía NaN.
  const maxDiscountCents =
    coupon.maxDiscount == null ? Infinity : toCents(coupon.maxDiscount);

  const rawDiscount =
    coupon.type === 'PERCENTAGE'
      ? percentOf(eligibleSubtotalCents, Number(coupon.value))
      : toCents(coupon.value);

  // Nunca se descuenta más que lo que los productos elegibles suman: un cupón de
  // 50 € aplicado a un carrito de 12 € daría un total negativo si no se recorta
  // aquí, y un cupón de 50 € sobre un carrito de 1.000 € del que solo 200 € son
  // elegibles se quedaría corto sin este recorte.
  const discountCents = Math.max(0, Math.min(rawDiscount, maxDiscountCents, eligibleSubtotalCents));

  if (discountCents === 0) reject('Este cupón no reduce el importe de tu pedido');

  return { discountCents, freeShipping: false, coupon, eligibleIndexes };
}

/**
 * Posiciones de las líneas a las que el cupón puede aplicarse.
 *
 * El `=== false` es deliberado: los cupones que llegan sin el campo (tests,
 * importaciones, cupones internos) valen para todo el catálogo en lugar de
 * quedarse sin usar.
 */
function eligibleLineIndexes(coupon, lines) {
  if (coupon.appliesToAllProducts !== false) {
    return lines.map((_, index) => index);
  }

  // Ojo: `coupon.products` son filas de `CouponProduct`, que no tienen `id`
  // propio; la clave del producto es `productId`. Leer `id` aquí daba
  // `undefined` y rechazaba también los carritos que sí cumplían la regla.
  const allowed = new Set((coupon.products ?? []).map((product) => product.productId));

  const indexes = [];
  lines.forEach((line, index) => {
    if (allowed.has(line.productId)) indexes.push(index);
  });
  return indexes;
}
