import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { distribute, toCents, fromCents } from '../src/utils/money.js';
import { quote, SHIPPING } from '../src/utils/pricing.js';

// ─────────────────────────────────────────────────────────────────────────────
// Aritmética en céntimos: es donde un descuadre de 0,01 € se cuela y nadie lo
// ve hasta la factura del cliente.
// ─────────────────────────────────────────────────────────────────────────────

describe('src/utils/money.js', () => {
  it('evita los errores de coma flotante', () => {
    expect(0.1 + 0.2).not.toBe(0.3); // por eso existe este módulo
    expect(toCents(0.1) + toCents(0.2)).toBe(toCents(0.3));
  });

  it('redondea a céntimos sin arrastrar error', () => {
    expect(toCents(19.999999)).toBe(2000);
    expect(fromCents(2000)).toBe(20);
    expect(toCents(79.9 * 3)).toBe(23970); // 239,70 €
    expect(toCents(10.005)).toBe(1001);
  });

  it('reparte sin perder ni inventar céntimos', () => {
    expect(distribute(100, [50, 50])).toEqual([50, 50]);
    expect(distribute(100, [1, 1, 1])).toEqual([34, 33, 33]);

    // La suma siempre cuadra, que es lo único que de verdad importa.
    for (const [total, weights] of [
      [100, [1, 1, 1]],
      [999, [3, 7, 11, 20]],
      [1, [1, 5, 9]],
      [12345, [1, 2, 3, 4, 5, 6, 7]]
    ]) {
      expect(distribute(total, weights).reduce((a, b) => a + b, 0)).toBe(total);
    }
  });

  it('devuelve ceros si no hay pesos que repartir', () => {
    expect(distribute(500, [0, 0])).toEqual([0, 0]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Presupuesto: mismos números en el carrito, en el checkout y en la factura.
// ─────────────────────────────────────────────────────────────────────────────

describe('src/utils/pricing.js', () => {
  const line = (overrides = {}) => ({
    variantId: 'v1',
    productId: 'p1',
    quantity: 1,
    unitPrice: 100,
    taxRate: 0.21,
    ...overrides
  });

  it('suma subtotal, IVA y envío correctamente', () => {
    const result = quote([line({ unitPrice: 20, quantity: 2 })]);

    expect(result.subtotalCents).toBe(4000);
    // Sin umbral de envío gratuito: el envío se cobra siempre (4,90).
    expect(result.shippingCents).toBe(SHIPPING.flatRateCents);
    expect(result.taxCents).toBe(840 + Math.round((490 * 21) / 100)); // IVA + IVA del envío
    // 40 + 4,90 envío + 8,40 IVA + 1,03 IVA del envío = 54,33
    expect(result.grandTotalCents).toBe(5433);
  });

  it('el IVA del envío se suma aparte (en España también se grava)', () => {
    const result = quote([line({ unitPrice: 20 })]);
    const shippingTax = Math.round((SHIPPING.flatRateCents * 21) / 100);

    expect(result.taxCents).toBe(420 + shippingTax);
  });

  it('cobra el envío a cualquier importe: no hay umbral de envío gratis', () => {
    const cheap = quote([line({ unitPrice: 40 })]); // 40
    const expensive = quote([line({ unitPrice: 600 })]); // 600

    // La tienda no promete envío gratuito por importe, así que ni el pedido
    // grande se libra: freeShipping solo llega por cupón.
    expect(cheap.freeShipping).toBe(false);
    expect(cheap.shippingCents).toBe(SHIPPING.flatRateCents);
    expect(expensive.freeShipping).toBe(false);
    expect(expensive.shippingCents).toBe(SHIPPING.flatRateCents);
  });

  it('el cupón de porcentaje respeta el techo de descuento', () => {
    const result = quote([line({ unitPrice: 100 })], {
      coupon: { id: 'c1', code: 'X', type: 'PERCENTAGE', value: 50, maxDiscount: 10, isActive: true }
    });

    expect(result.discountCents).toBe(1000); // 50 % son 50 €, pero el techo es 10 €
  });

  it('un cupón fijo nunca deja el total en negativo', () => {
    const result = quote([line({ unitPrice: 12 })], {
      coupon: { id: 'c1', code: 'X', type: 'FIXED_AMOUNT', value: 50, isActive: true }
    });

    expect(result.discountCents).toBe(1200); // ni un céntimo más de lo que hay
    expect(result.grandTotalCents).toBeGreaterThan(0);
  });

  it('reparte el descuento entre las líneas de forma proporcional', () => {
    const result = quote([line({ unitPrice: 100, quantity: 3 }), line({ unitPrice: 100, variantId: 'v2' })], {
      coupon: { id: 'c1', code: 'X', type: 'FIXED_AMOUNT', value: 40, isActive: true }
    });

    // 3/4 del descuento para la primera línea (300 €), 1/4 para la segunda.
    expect(result.lines[0].discountCents).toBe(3000);
    expect(result.lines[1].discountCents).toBe(1000);
    expect(result.lines[0].lineTotalCents + result.lines[1].lineTotalCents).toBe(
      result.subtotalCents - result.discountCents
    );
  });

  it('rechaza cupones caducados, inactivos o por debajo del mínimo', () => {
    const base = { id: 'c1', code: 'X', type: 'FIXED_AMOUNT', value: 5, isActive: true };

    expect(() =>
      quote([line()], { coupon: { ...base, isActive: false } })
    ).toThrow(/ya no está activo/i);

    expect(() =>
      quote([line()], { coupon: { ...base, expiresAt: new Date('2000-01-01') } })
    ).toThrow(/caducado/i);

    expect(() =>
      quote([line()], { coupon: { ...base, startsAt: new Date('2999-01-01') } })
    ).toThrow(/todavía no está disponible/i);

    expect(() =>
      quote([line({ unitPrice: 10 })], { coupon: { ...base, minSubtotal: 100 } })
    ).toThrow(/mínimo/i);
  });

  it('respeta el límite de usos y el límite por usuario', () => {
    const coupon = { id: 'c1', code: 'X', type: 'FIXED_AMOUNT', value: 5, isActive: true };

    expect(() =>
      quote([line()], { coupon: { ...coupon, usageLimit: 2, usedCount: 2 } })
    ).toThrow(/límite de usos/i);

    expect(() => quote([line()], { coupon: { ...coupon, perUserLimit: 1 }, userUses: 1 })).toThrow(
      /máximo/i
    );
  });

  it('rechaza un cupón restringido si ningún producto encaja', () => {
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'FIXED_AMOUNT',
      value: 5,
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'otro' }]
    };

    expect(() => quote([line({ productId: 'p1' })], { coupon })).toThrow(/no se puede aplicar/i);
  });

  it('aplica un cupón restringido cuando el carrito sí incluye el producto', () => {
    // Contracara del test anterior: sin este caso, un `product.id` equivocado
    // (las filas de CouponProduct no tienen id) pasaba el test anterior por el
    // motivo equivocado y rechazaba de más.
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'FIXED_AMOUNT',
      value: 5,
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p2' }]
    };

    const result = quote([line({ productId: 'p1' }), line({ productId: 'p2' })], { coupon });
    expect(result.discountCents).toBe(500);
  });

  it('exige que el producto restringido esté en el carrito aunque haya otro', () => {
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'PERCENTAGE',
      value: 50,
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p1' }]
    };

    expect(() => quote([line({ productId: 'p9' })], { coupon })).toThrow(/no se puede aplicar/i);
  });

  // ── El cupón se calcula sobre los productos ELEGIBLES, no sobre el carrito ──
  //
  // Antes, el porcentaje se aplicaba al subtotal ENTERO y el reparto caía sobre
  // todas las líneas: un 50 % restringido a un producto de 100 € aplicaba el 50 %
  // de los 200 € del carrito y 50 € de descuento aterrizaban en un producto que
  // el cupón excluía. Es pérdida de ingresos directa y una factura que no cuadra.

  it('un cupón restringido solo descuenta sobre los productos elegibles', () => {
    const coupon = {
      id: 'c1',
      code: 'SOLO_P2',
      type: 'PERCENTAGE',
      value: 50,
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p2' }]
    };

    const result = quote([line({ productId: 'p1' }), line({ productId: 'p2' })], { coupon });

    // 50 % de 100 € (lo elegible), no del 200 € del carrito.
    expect(result.discountCents).toBe(5000);
    expect(result.lines[0].discountCents).toBe(0);
    expect(result.lines[1].discountCents).toBe(5000);
    expect(result.lines.reduce((total, l) => total + l.discountCents, 0)).toBe(result.discountCents);
  });

  it('un cupón fijo restringido se recorta al importe elegible, no al carrito', () => {
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'FIXED_AMOUNT',
      value: 500, // 500 €
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p2' }]
    };

    // p1 vale 1.000 € pero no es elegible: solo se pueden descontar los 100 € de p2.
    const result = quote([line({ productId: 'p1', unitPrice: 1000 }), line({ productId: 'p2' })], {
      coupon
    });

    expect(result.discountCents).toBe(10000);
    expect(result.lines[0].discountCents).toBe(0);
  });

  it('el pedido mínimo se mide sobre los productos elegibles', () => {
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'PERCENTAGE',
      value: 50,
      minSubtotal: 150,
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p2' }]
    };

    // 100 € elegibles (p2) + 200 € no elegibles (p1): el mínimo no se cumple.
    expect(() =>
      quote([line({ productId: 'p1', unitPrice: 200 }), line({ productId: 'p2' })], { coupon })
    ).toThrow(/mínimo/i);

    // Con 150 € elegibles sí se acepta.
    const ok = quote([line({ productId: 'p1', unitPrice: 200 }), line({ productId: 'p2', unitPrice: 150 })], {
      coupon
    });
    expect(ok.discountCents).toBe(7500);
  });

  it('el reparto nunca deja un céntimo en una línea no elegible', () => {
    // p1 no elegible con peso 0 y p2 elegible: si el céntimo sobrante se repartiera
    // por peso, podía acabar en la línea que el cupón excluye.
    const coupon = {
      id: 'c1',
      code: 'X',
      type: 'FIXED_AMOUNT',
      value: 10.01, // 1001 céntimos: impar, obliga a repartir un resto
      isActive: true,
      appliesToAllProducts: false,
      products: [{ productId: 'p2' }]
    };

    const result = quote([line({ productId: 'p1' }), line({ productId: 'p2' })], { coupon });

    expect(result.lines[0].discountCents).toBe(0);
    expect(result.lines[1].discountCents).toBe(1001);
  });

  it('el cupón FREE_SHIPPING anula el envío sin tocar el descuento', () => {
    const result = quote([line()], {
      coupon: { id: 'c1', code: 'ENVIO', type: 'FREE_SHIPPING', value: 0, isActive: true }
    });

    expect(result.freeShipping).toBe(true);
    expect(result.shippingCents).toBe(0);
    expect(result.discountCents).toBe(0);
  });

  it('un carrito vacío no cobra envío ni IVA', () => {
    const result = quote([]);

    expect(result.shippingCents).toBe(0);
    expect(result.taxCents).toBe(0);
    expect(result.grandTotalCents).toBe(0);
  });
});
