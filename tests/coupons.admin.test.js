import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

const COUPONS = '/api/v1/coupons';

// Purga por prefijo de código: si un test revienta a medias, sus cupones se
// borran igual en el después-de-todo en lugar de acumularse en la BD.
const TEST_CODE_PREFIX = 'ZZTEST';
const createdCouponIds = []; // ids, solo para aserciones y limpieza fina
const createdOrderIds = []; // pedidos de prueba que citan un cupón

let adminToken;
let customerToken;
let customerId;

async function tokenFor(email, password) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken;
}

const withAuth = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

const uniqueCode = (suffix = '') =>
  `${TEST_CODE_PREFIX}${suffix}${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`;

const newCoupon = (overrides = {}) => ({
  code: uniqueCode(),
  type: 'PERCENTAGE',
  value: 10,
  ...overrides
});

async function purgeTestCoupons() {
  await prisma.coupon.deleteMany({ where: { code: { startsWith: TEST_CODE_PREFIX } } });
}

beforeAll(async () => {
  await purgeTestCoupons();
  adminToken = await tokenFor('admin@extramoda.es', 'Password123!');
  customerToken = await tokenFor('cliente@ejemplo.com', 'Password123!');

  const customer = await prisma.user.findUnique({
    where: { email: 'cliente@ejemplo.com' },
    select: { id: true }
  });
  customerId = customer.id;
});

afterAll(async () => {
  // Los pedidos se borran primero: citan cupones (onDelete: SetNull en la BD,
  // pero borrar en este orden deja la limpieza explícita).
  if (createdOrderIds.length) {
    await prisma.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  }
  await purgeTestCoupons();
});

// ── Control de acceso ────────────────────────────────────────────────────────

describe('Cupones: control de acceso', () => {
  it('rechaza el listado sin token con 401', async () => {
    const res = await request(app).get(COUPONS);
    expect(res.status).toBe(401);
  });

  it('rechaza crear a un CUSTOMER con 403', async () => {
    const res = await withAuth('post', COUPONS, customerToken).send(newCoupon());
    expect(res.status).toBe(403);
  });

  it('rechaza el borrado a un CUSTOMER con 403', async () => {
    const res = await withAuth('delete', `${COUPONS}/clxxxxxxxxxxxxxxxxxx`, customerToken);
    expect(res.status).toBe(403);
  });
});

// ── Alta ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/coupons', () => {
  it('crea un cupón de porcentaje normalizando el código a mayúsculas', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ code: uniqueCode('-mix').toLowerCase(), value: 15, usageLimit: 100 })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^ZZTEST/);
    expect(res.body.data.state).toBe('ACTIVE');
    expect(res.body.data.stateLabel).toBe('Activo');
    createdCouponIds.push(res.body.data.id);
  });

  it('crea un cupón de importe fijo y uno de envío gratuito', async () => {
    const fixed = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ type: 'FIXED_AMOUNT', value: 20, minSubtotal: 100 })
    );
    expect(fixed.status).toBe(201);
    expect(Number(fixed.body.data.value)).toBe(20);
    expect(Number(fixed.body.data.minSubtotal)).toBe(100);
    createdCouponIds.push(fixed.body.data.id);

    const shipping = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ type: 'FREE_SHIPPING', value: 0 })
    );
    expect(shipping.status).toBe(201);
    expect(shipping.body.data.type).toBe('FREE_SHIPPING');
    createdCouponIds.push(shipping.body.data.id);
  });

  it('rechaza un código duplicado con 409', async () => {
    const code = uniqueCode('-dup');
    const first = await withAuth('post', COUPONS, adminToken).send(newCoupon({ code }));
    createdCouponIds.push(first.body.data.id);

    // En minúsculas: la comparación es insensible a mayúsculas.
    const second = await withAuth('post', COUPONS, adminToken).send(newCoupon({ code: code.toLowerCase() }));

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE');
  });

  it('rechaza un porcentaje superior a 100 con 422', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(newCoupon({ value: 150 }));
    expect(res.status).toBe(422);
  });

  it('rechaza fin anterior a inicio con 422', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({
        startsAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-05-01T00:00:00.000Z'
      })
    );
    expect(res.status).toBe(422);
  });

  it('rechaza restringir a productos sin indicar cuáles', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ appliesToAllProducts: false })
    );
    expect(res.status).toBe(422);
    expect(res.body.errors?.productIds ?? JSON.stringify(res.body)).toBeTruthy();
  });

  it('rechaza productos inexistentes con 400', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ appliesToAllProducts: false, productIds: ['clxxxxxxxxxxxxxxxxxx'] })
    );
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no existe/i);
  });

  it('rechaza un código con caracteres inválidos con 422', async () => {
    const res = await withAuth('post', COUPONS, adminToken).send(newCoupon({ code: 'codigo con espacios' }));
    expect(res.status).toBe(422);
  });
});

// ── Modificación ─────────────────────────────────────────────────────────────

describe('PATCH /api/v1/coupons/:id', () => {
  it('actualiza el valor y el estado', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon());
    createdCouponIds.push(created_.body.data.id);

    const res = await withAuth('patch', `${COUPONS}/${created_.body.data.id}`, adminToken).send({
      value: 25,
      isActive: false
    });

    expect(res.status).toBe(200);
    expect(Number(res.body.data.value)).toBe(25);
    expect(res.body.data.state).toBe('INACTIVE');
  });

  it('calcula el estado SCHEDULED con fecha de inicio futura', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon({ startsAt: future }));
    createdCouponIds.push(created_.body.data.id);

    expect(created_.body.data.state).toBe('SCHEDULED');
  });

  it('calcula el estado EXPIRED con fecha de fin pasada', async () => {
    const past = new Date(Date.now() - 86_400_000).toISOString();
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon({ expiresAt: past }));
    createdCouponIds.push(created_.body.data.id);

    expect(created_.body.data.state).toBe('EXPIRED');
  });

  it('calcula el estado EXHAUSTED al alcanzar el límite de usos', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon({ usageLimit: 3 }));
    createdCouponIds.push(created_.body.data.id);

    await prisma.coupon.update({ where: { id: created_.body.data.id }, data: { usedCount: 3 } });

    const res = await withAuth('get', `${COUPONS}?state=all`, adminToken);
    const found = res.body.data.find((coupon) => coupon.id === created_.body.data.id);
    expect(found.state).toBe('EXHAUSTED');
  });

  it('limpia límites con null', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(
      newCoupon({ usageLimit: 10, minSubtotal: 50, maxDiscount: 5 })
    );
    createdCouponIds.push(created_.body.data.id);

    const res = await withAuth('patch', `${COUPONS}/${created_.body.data.id}`, adminToken).send({
      usageLimit: null,
      minSubtotal: null,
      maxDiscount: null
    });

    expect(res.status).toBe(200);
    expect(res.body.data.usageLimit).toBeNull();
    expect(res.body.data.minSubtotal).toBeNull();
    expect(res.body.data.maxDiscount).toBeNull();
  });

  it('devuelve 404 con un id válido inexistente', async () => {
    const res = await withAuth('patch', `${COUPONS}/clxxxxxxxxxxxxxxxxxx`, adminToken).send({ value: 5 });
    expect(res.status).toBe(404);
  });
});

// ── Baja ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/coupons/:id', () => {
  it('borra un cupón que nunca se usó', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon());
    const res = await withAuth('delete', `${COUPONS}/${created_.body.data.id}`, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.data.deleted).toBe(true);

    const row = await prisma.coupon.findUnique({ where: { id: created_.body.data.id } });
    expect(row).toBeNull();
  });

  it('desactiva en lugar de borrar si ya se usó en un pedido', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon());
    createdCouponIds.push(created_.body.data.id);

    // Pedido mínimo que cita el cupón: simula una promoción ya consumida.
    const order = await prisma.order.create({
      data: {
        orderNumber: `ZZT-ORD-${Date.now()}`,
        userId: customerId,
        email: 'cliente@ejemplo.com',
        subtotal: 100,
        grandTotal: 90,
        couponId: created_.body.data.id,
        couponCode: created_.body.data.code
      },
      select: { id: true }
    });
    createdOrderIds.push(order.id);

    const res = await withAuth('delete', `${COUPONS}/${created_.body.data.id}`, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/desactivado/i);

    const row = await prisma.coupon.findUnique({ where: { id: created_.body.data.id } });
    expect(row).not.toBeNull();
    expect(row.isActive).toBe(false);
  });
});

// ── Listado ─────────────────────────────────────────────────────────────────

describe('GET /api/v1/coupons', () => {
  it('devuelve metadatos de paginación y los contadores', async () => {
    const created_ = await withAuth('post', COUPONS, adminToken).send(newCoupon());
    createdCouponIds.push(created_.body.data.id);

    const res = await withAuth('get', `${COUPONS}?state=all`, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThan(0);
    expect(res.body.meta.totalPages).toBeGreaterThanOrEqual(1);

    const coupon = res.body.data.find((item) => item.id === created_.body.data.id);
    expect(coupon.orderCount).toBe(0);
    expect(coupon.products).toEqual([]);
  });

  it('filtra por activos', async () => {
    const active = await withAuth('post', COUPONS, adminToken).send(newCoupon());
    createdCouponIds.push(active.body.data.id);
    const inactive = await withAuth('post', COUPONS, adminToken).send(newCoupon({ isActive: false }));
    createdCouponIds.push(inactive.body.data.id);

    const res = await withAuth('get', `${COUPONS}?state=active`, adminToken);
    const ids = res.body.data.map((coupon) => coupon.id);

    expect(ids).toContain(active.body.data.id);
    expect(ids).not.toContain(inactive.body.data.id);
  });
});
