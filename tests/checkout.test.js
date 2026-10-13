import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

/**
 * Fixtures: productos/variantes propios de esta suite.
 *
 * No se usan los del seed a propósito. Un checkout descuenta stock real, y si
 * el test tocara `camiseta-essential` dejaría el catálogo de desarrollo con
 * números que no cuadran con el seed. Creando productos propios, al borrar la
 * suite (en cascada) el stock vuelve a estar donde estaba.
 */

const PREFIX = 'CRD-';
const api = '/api/v1';

let customerToken;
let otherToken;
let adminToken;
let product; // { id, slug, variants: [...] }
let otherProduct;
const createdUsers = [];
// Contadores de los cupones del seed al empezar la suite, para devolverlos al
// mismo valor al terminar. El valor se LEE aquí: una promesa de Prisma no se
// ejecuta hasta que se hace await, y leerlo en afterAll guardaría el valor ya
// gastado por los propios tests.
const couponUsageBefore = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

const auth = (token) => (req) => req.set('Authorization', `Bearer ${token}`);
const get = (url, token) => request(app).get(url).set('Authorization', `Bearer ${token}`);
const post = (url, body, token) =>
  request(app).post(url).set('Authorization', `Bearer ${token}`).send(body);
/** Igual que `post`, pero con la cabecera de idempotencia del checkout. */
const postWithKey = (url, body, token, idempotencyKey) =>
  request(app)
    .post(url)
    .set('Authorization', `Bearer ${token}`)
    .set('Idempotency-Key', idempotencyKey)
    .send(body);
const patch = (url, body, token) =>
  request(app).patch(url).set('Authorization', `Bearer ${token}`).send(body);
const del = (url, token) => request(app).delete(url).set('Authorization', `Bearer ${token}`);

async function registerAndLogin(prefix) {
  const email = `${prefix}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@ejemplo.com`;
  createdUsers.push(email);

  const res = await request(app).post(`${api}/auth/register`).send({
    firstName: 'Cliente',
    lastName: 'Compra',
    email,
    password: 'Password123'
  });

  expect(res.status).toBe(201);
  return res.body.data.accessToken;
}

/** El helper devuelve el token, pero varios tests necesitan identificar al
 *  usuario en la base de datos: se saca el `sub` del JWT. */
function userIdFromToken(token) {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
}

const address = {
  firstName: 'Ana',
  lastName: 'García',
  line1: 'Calle Mayor 1',
  city: 'Madrid',
  province: 'Madrid',
  postalCode: '28013'
};

async function createProduct({ basePrice = 40, stock = 10, salePrice } = {}) {
  const res = await post(
    `${api}/products`,
    {
      name: `Producto Carrito ${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
      sku: `${PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      description: 'Producto creado por la suite de carrito y pedidos.',
      basePrice,
      ...(salePrice !== undefined && { salePrice }),
      status: 'ACTIVE',
      variants: [{ stock }]
    },
    adminToken
  );

  expect(res.status).toBe(201);
  return res.body.data;
}

beforeAll(async () => {
  adminToken = (
    await request(app)
      .post(`${api}/auth/login`)
      .send({ email: 'admin@extramoda.es', password: 'Password123!' })
  ).body.data.accessToken;

  customerToken = await registerAndLogin('carrito');
  otherToken = await registerAndLogin('otro');

  product = await createProduct({ basePrice: 40, stock: 60 });
  otherProduct = await createProduct({ basePrice: 100, stock: 3 });

  const welcome = await prisma.coupon.findUnique({ where: { code: 'BIENVENIDA10' } });
  couponUsageBefore.set('BIENVENIDA10', welcome.usedCount);

  // ENVIOGRATIS no lo consume ningún test hoy, pero se apunta igualmente: si
  // alguno empieza a pagar un pedido con él, la suite sigue siendo repetible.
  const freeShip = await prisma.coupon.findUnique({ where: { code: 'ENVIOGRATIS' } });
  couponUsageBefore.set('ENVIOGRATIS', freeShip.usedCount);
});

afterAll(async () => {
  // Primero los pedidos: `OrderItem` tiene Restrict hacia Product.
  await prisma.order.deleteMany({ where: { user: { email: { in: createdUsers } } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
  await prisma.user.deleteMany({ where: { email: { in: createdUsers } } });

  // Los usos de cupón NO se deshacen al borrar los pedidos (los consumió el
  // servicio, no una cascada), así que se restauran a mano: si no, cada
  // ejecución dejaba `usedCount` más alto y la suite acabaría agotando el
  // `usageLimit` del cupón del seed.
  for (const [code, usedCount] of couponUsageBefore) {
    await prisma.coupon.update({ where: { code }, data: { usedCount } });
  }
});

// ── Carrito ──────────────────────────────────────────────────────────────────

describe('Carrito', () => {
  it('exige autenticación', async () => {
    expect((await request(app).get(`${api}/cart`)).status).toBe(401);
    expect((await request(app).post(`${api}/cart/items`).send({ variantId: 'x' })).status).toBe(401);
  });

  it('devuelve un carrito vacío con totales a cero', async () => {
    const res = await get(`${api}/cart`, customerToken);

    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    expect(res.body.data.totals).toMatchObject({
      subtotal: 0,
      shipping: 0,
      tax: 0,
      total: 0
    });
  });

  it('crea el carrito en la primera llamada y lo reutiliza', async () => {
    const first = await get(`${api}/cart`, customerToken);
    const second = await get(`${api}/cart`, customerToken);

    expect(second.body.data.id).toBe(first.body.data.id);
  });

  it('añade una variante y calcula los totales con IVA', async () => {
    const res = await post(
      `${api}/cart/items`,
      { variantId: product.variants[0].id, quantity: 2 },
      customerToken
    );

    expect(res.status).toBe(201);
    expect(res.body.data.quantity).toBe(2);
    expect(res.body.data.unitPrice).toBe(40);

    const cart = (await get(`${api}/cart`, customerToken)).body.data;
    expect(cart.itemCount).toBe(2);
    expect(cart.totals.subtotal).toBe(80);
    // Sin envío gratuito por umbral: 80 + 4,90 de envío + 16,80 de IVA + 1,03 del IVA del envío
    expect(cart.totals.shipping).toBe(4.9);
    expect(cart.totals.total).toBe(102.73);
  });

  it('suma la cantidad si se repite la misma variante', async () => {
    const variantId = product.variants[0].id;

    await post(`${api}/cart/items`, { variantId, quantity: 1 }, customerToken);
    const cart = (await get(`${api}/cart`, customerToken)).body.data;

    const line = cart.items.find((item) => item.variant.id === variantId);
    expect(line.quantity).toBe(3);
    expect(cart.items).toHaveLength(1);
  });

  it('con dos "añadir" simultáneos suma en vez de fallar', async () => {
    // Doble clic en "añadir al carrito". En MySQL el upsert de Prisma es un
    // SELECT + INSERT, así que los dos intentos llegan al INSERT y uno revienta
    // con P2002 (500). Con el reintento, el cliente ve las 3 unidades.
    const user = await registerAndLogin('doble-add');
    const variantId = product.variants[0].id;

    const [a, b] = await Promise.all([
      post(`${api}/cart/items`, { variantId, quantity: 1 }, user),
      post(`${api}/cart/items`, { variantId, quantity: 2 }, user)
    ]);

    expect([a.status, b.status]).toEqual([201, 201]);

    const cart = (await get(`${api}/cart`, user)).body.data;
    expect(cart.items).toHaveLength(1);
    expect(cart.items[0].quantity).toBe(3);
  });

  it('rechaza comprar más stock del disponible', async () => {
    const res = await post(
      `${api}/cart/items`,
      { variantId: otherProduct.variants[0].id, quantity: 4 },
      customerToken
    );

    expect(res.status).toBe(409);
    expect(res.body.errors.available).toBe(3);
    expect(res.body.message).toMatch(/quedan 3/i);
  });

  it('rechaza una variante inexistente o archivada con 404', async () => {
    expect(
      (await post(`${api}/cart/items`, { variantId: 'clxxxxxxxxxxxxxxxxxxxx' }, customerToken)).status
    ).toBe(404);

    const draft = await post(
      `${api}/products`,
      {
        name: `Archivado ${Date.now()}`,
        sku: `${PREFIX}ARC${Date.now()}`,
        description: 'Producto que se archiva nada más crearse.',
        basePrice: 10,
        status: 'DRAFT'
      },
      adminToken
    );

    expect((await post(`${api}/cart/items`, { variantId: draft.body.data.variants?.[0]?.id ?? draft.body.data.id }, customerToken)).status).toBe(404);
  });

  it('valida la cantidad con 422', async () => {
    const variantId = product.variants[0].id;

    expect((await post(`${api}/cart/items`, { variantId, quantity: 0 }, customerToken)).status).toBe(422);
    expect((await post(`${api}/cart/items`, { variantId, quantity: 99 }, customerToken)).status).toBe(422);
    expect((await post(`${api}/cart/items`, { variantId, quantity: 1.5 }, customerToken)).status).toBe(422);
  });

  it('no deja tocar una línea del carrito de otro usuario', async () => {
    const myCart = (await get(`${api}/cart`, customerToken)).body.data;
    const lineId = myCart.items[0].id;

    // 404 y no 403: no revelamos que esa línea existe en el carrito ajeno.
    const stolen = await patch(`${api}/cart/items/${lineId}`, { quantity: 1 }, otherToken);
    expect(stolen.status).toBe(404);

    const remove = await del(`${api}/cart/items/${lineId}`, otherToken);
    expect(remove.status).toBe(404);
  });

  it('actualiza la cantidad de una línea', async () => {
    const cart = (await get(`${api}/cart`, customerToken)).body.data;
    const lineId = cart.items[0].id;

    const res = await patch(`${api}/cart/items/${lineId}`, { quantity: 1 }, customerToken);

    expect(res.status).toBe(200);
    expect(res.body.data.itemCount).toBe(1);
  });

  it('elimina una línea y vacía el carrito entero', async () => {
    let cart = (await get(`${api}/cart`, customerToken)).body.data;
    const lineId = cart.items[0].id;

    const removed = await del(`${api}/cart/items/${lineId}`, customerToken);
    expect(removed.status).toBe(200);
    expect(removed.body.data.items).toEqual([]);

    await post(`${api}/cart/items`, { variantId: product.variants[0].id }, customerToken);
    cart = (await get(`${api}/cart`, customerToken)).body.data;
    expect(cart.items).toHaveLength(1);

    const cleared = await del(`${api}/cart`, customerToken);
    expect(cleared.body.data.items).toEqual([]);
  });

  it('avisa si el precio cambió desde que se añadió', async () => {
    const variantId = product.variants[0].id;
    await post(`${api}/cart/items`, { variantId }, customerToken);

    // Otro gestor sube el precio de la variante mientras el cliente decide.
    await prisma.productVariant.update({ where: { id: variantId }, data: { price: 45 } });

    const cart = (await get(`${api}/cart`, customerToken)).body.data;
    const line = cart.items.find((item) => item.variant.id === variantId);

    expect(line.priceChangedSinceAdded).toBe(true);
    expect(line.previousUnitPrice).toBe(40);
    expect(line.unitPrice).toBe(45);
    expect(cart.totals.subtotal).toBe(45); // el carrito cobra lo de hoy

    await del(`${api}/cart`, customerToken);
    await prisma.productVariant.update({ where: { id: variantId }, data: { price: 40 } });
  });

  it('el precio del carrito es el de la variante, no el del producto', async () => {
    // El precio de venta vive en la variante; cambiar el del producto no debe
    // alterar lo que ve el cliente hasta que se actualice la variante.
    await post(`${api}/cart/items`, { variantId: product.variants[0].id }, customerToken);
    await patch(`${api}/products/${product.slug}`, { basePrice: 60 }, adminToken);

    const cart = (await get(`${api}/cart`, customerToken)).body.data;
    expect(cart.items[0].unitPrice).toBe(40);
    expect(cart.items[0].priceChangedSinceAdded).toBe(false);

    await patch(`${api}/products/${product.slug}`, { basePrice: 40 }, adminToken);
  });
});

// ── Cupones en el carrito ────────────────────────────────────────────────────

describe('Cupones', () => {
  // Usuario propio: BIENVENIDA10 tiene perUserLimit = 1, así que un usuario
  // que ya lo gastó no puede volver a aplicarlo (y eso se prueba aparte).
  let couponUser;
  let minCoupon;

  beforeAll(async () => {
    couponUser = await registerAndLogin('cupones');

    minCoupon = await prisma.coupon.create({
      data: {
        code: `MIN${Date.now().toString().slice(-6)}`,
        type: 'FIXED_AMOUNT',
        value: 10,
        minSubtotal: 500,
        isActive: true
      }
    });

    await del(`${api}/cart`, couponUser);
    await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 2 }, couponUser);
  });

  afterAll(async () => {
    await prisma.coupon.delete({ where: { id: minCoupon.id } }).catch(() => {});
  });

  it('aplica un cupón válido y descuenta en el total', async () => {
    const res = await post(`${api}/cart/coupon`, { code: 'bienvenida10' }, couponUser);

    expect(res.status).toBe(200);
    expect(res.body.data.coupon.code).toBe('BIENVENIDA10');
    expect(res.body.data.coupon.discount).toBe(8); // 10 % de 80 €
    expect(res.body.data.totals.discount).toBe(8);
    // 80 − 8 = 72, más 4,90 de envío, más IVA 21 % de 72 (15,12) y del envío (1,03)
    expect(res.body.data.totals.total).toBe(93.05);
  });

  it('normaliza el código (minúsculas y espacios)', async () => {
    const res = await post(`${api}/cart/coupon`, { code: '  bienvenida10  ' }, couponUser);
    expect(res.body.data.coupon.code).toBe('BIENVENIDA10');
  });

  it('aplica un cupón de envío gratis sin tocar el descuento', async () => {
    await post(`${api}/cart/items`, { variantId: product.variants[0].id }, couponUser);

    const res = await post(`${api}/cart/coupon`, { code: 'enviogratis' }, couponUser);

    expect(res.status).toBe(200);
    expect(res.body.data.coupon.type).toBe('FREE_SHIPPING');
    expect(res.body.data.coupon.discount).toBe(0);
    expect(res.body.data.totals.shipping).toBe(0);
  });

  it('rechaza un cupón que no llega al mínimo de compra, con el motivo', async () => {
    const res = await post(`${api}/cart/coupon`, { code: minCoupon.code }, couponUser);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/mínimo/i);
    expect(res.body.errors.code).toBe('COUPON_INVALID');
  });

  it('rechaza un código inexistente con 404', async () => {
    const res = await post(`${api}/cart/coupon`, { code: 'NOEXISTE999' }, couponUser);
    expect(res.status).toBe(404);
  });

  it('no deja usar dos veces un cupón con límite por usuario', async () => {
    await del(`${api}/cart`, couponUser);
    await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 2 }, couponUser);

    const first = await post(`${api}/cart/items`, { variantId: product.variants[0].id }, couponUser);
    expect(first.status).toBe(201);

    // Se compra con el cupón (consume el uso)…
    await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD', couponCode: 'BIENVENIDA10' },
      couponUser
    );

    // …y a partir de ahí el mismo cupón se rechaza.
    await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 2 }, couponUser);
    const second = await post(`${api}/cart/coupon`, { code: 'bienvenida10' }, couponUser);

    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/máximo/i);
  });

  it('con dos checkouts simultáneos solo aplica el cupón a uno', async () => {
    // Dos pestañes ícone "finalizar compra" a la vez. `perUserLimit = 1`:
    // validar el cupón fuera de la transacción deja pasar a las dos, y el
    // descuento se aplicaría dos veces. Al entrar, la segunda ve el pedido que
    // la primera acaba de confirmar y se deshace.
    const user = await registerAndLogin('doble-cupon');
    const variantId = product.variants[0].id;
    const address = {
      firstName: 'Ana',
      lastName: 'Sanz',
      line1: 'Avenida del Mar 1',
      city: 'Alicante',
      province: 'Alicante',
      postalCode: '03001'
    };
    const buy = async () => {
      await del(`${api}/cart`, user);
      await post(`${api}/cart/items`, { variantId, quantity: 2 }, user);
      return post(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD', couponCode: 'BIENVENIDA10' },
        user
      );
    };

    const [a, b] = await Promise.all([buy(), buy()]);

    const created = [a, b].filter((res) => res.status === 201);
    const rejected = [a, b].filter((res) => res.status !== 201);

    expect(created).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // El CÓDIGO de error del perdedor depende de en qué punto se perdió la
    // carrera, así que no se puede fijar: si el quote perdedor corre antes de que
    // la primera confirme, ambos validan el cupón y el choque ocurre dentro de la
    // transacción (COUPON_LIMIT_REACHED); si corre después, la validación ya ve
    // el uso y lo rechaza antes de escribir nada (COUPON_INVALID). Ambos
    // rechazos son correctos. Antes este test exigía el primer código y fallaba
    // de forma intermitente según la carga de la máquina.
    expect(['COUPON_INVALID', 'COUPON_LIMIT_REACHED']).toContain(rejected[0].body.errors.code);
    expect(rejected[0].body.errors.code).toBeDefined();

    // Solo queda un pedido de este usuario con ese cupón, aunque las dos
    // peticiones salieron a la vez.
    const orders = await prisma.order.count({
      where: { userId: userIdFromToken(user), couponCode: 'BIENVENIDA10' }
    });
    expect(orders).toBe(1);
  });

  it('quitar el cupón no necesita tocar la base de datos', async () => {
    const res = await del(`${api}/cart/coupon`, couponUser);
    expect(res.status).toBe(200);
    expect(res.body.data.totals.discount).toBe(0);
  });
});

// ── Checkout ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/orders', () => {
  beforeAll(async () => {
    await del(`${api}/cart`, customerToken);
    await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 2 }, customerToken);
  });

  it('exige autenticación y una dirección', async () => {
    expect(
      (await request(app).post(`${api}/orders`).send({ ...address, paymentMethod: 'CARD' })).status
    ).toBe(401);

    const noAddress = await post(`${api}/orders`, { paymentMethod: 'CARD' }, customerToken);
    expect(noAddress.status).toBe(422);
    expect(noAddress.body.errors.shippingAddress).toBeTruthy();
  });

  // ── Idempotencia ────────────────────────────────────────────────────────────
  //
  // Sin esto, un doble clic en "pagar" creaba dos pedidos y descontaba el stock
  // dos veces. El CAS de stock evita que quede en negativo, pero no el cobro
  // duplicado.

  describe('Idempotency-Key', () => {
    it('devuelve el MISMO pedido si llega dos veces con la misma clave', async () => {
      const token = await registerAndLogin('idem-secuencial');
      const variantId = product.variants[0].id;
      const key = 'idem-secuencial-0001';

      await post(`${api}/cart/items`, { variantId, quantity: 1 }, token);

      const stockBefore = (await prisma.productVariant.findUnique({ where: { id: variantId } })).stock;

      const first = await postWithKey(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD' },
        token,
        key
      );

      expect(first.status).toBe(201);

      // El cliente no vio la respuesta y reintenta con la misma clave.
      const second = await postWithKey(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD' },
        token,
        key
      );

      // 200 y no 201: el recurso ya existía, no se ha creado un pedido nuevo.
      expect(second.status).toBe(200);
      expect(second.body.data.id).toBe(first.body.data.id);
      expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);

      // Y el stock solo se descontó una vez.
      const stockAfter = (await prisma.productVariant.findUnique({ where: { id: variantId } })).stock;
      expect(stockBefore - stockAfter).toBe(1);

      const count = await prisma.order.count({ where: { userId: userIdFromToken(token) } });
      expect(count).toBe(1);
    });

    it('no vacía el carrito en el reintento (puede contener productos nuevos)', async () => {
      const token = await registerAndLogin('idem-carrito');
      const variantId = product.variants[0].id;
      const key = 'idem-carrito-0001';

      await post(`${api}/cart/items`, { variantId, quantity: 1 }, token);

      await postWithKey(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD' },
        token,
        key
      );

      // El usuario añade otra cosa DESPUÉS del primer checkout…
      await post(`${api}/cart/items`, { variantId: otherProduct.variants[0].id, quantity: 1 }, token);

      // …y reintenta el mismo pago por si la respuesta se perdió.
      const retry = await postWithKey(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD' },
        token,
        key
      );

      expect(retry.status).toBe(200);

      // El producto nuevo sigue en el carrito: vaciarlo en el reintento sería
      // borrar una compra que el usuario todavía no ha confirmado.
      const cart = (await get(`${api}/cart`, token)).body.data;
      expect(cart.items).toHaveLength(1);
      expect(cart.items[0].variant.id).toBe(otherProduct.variants[0].id);
    });

    it('dos checkouts simultáneos con la misma clave crean un solo pedido', async () => {
      const token = await registerAndLogin('idem-paralelo');
      const variantId = product.variants[0].id;
      const key = 'idem-paralelo-0001';

      // Un único producto en el carrito: las dos peticiones cotizan el MISMO
      // carrito y compiten por la misma clave.
      await post(`${api}/cart/items`, { variantId, quantity: 1 }, token);

      const stockBefore = (await prisma.productVariant.findUnique({ where: { id: variantId } })).stock;

      // Dos "pagar" a la vez, como dos clics rápidos o un retry que pisa al
      // primero. Ambos comparten la MISMA clave.
      const buy = async () => {
        const res = await postWithKey(
          `${api}/orders`,
          { shippingAddress: address, paymentMethod: 'CARD' },
          token,
          key
        );
        return res;
      };

      const [a, b] = await Promise.all([buy(), buy()]);

      // Uno crea (201) y el otro recibe el mismo pedido (200).
      expect([a.status, b.status].sort()).toEqual([200, 201]);

      const orderIds = new Set([a.body.data.id, b.body.data.id]);
      expect(orderIds.size).toBe(1);

      const count = await prisma.order.count({ where: { userId: userIdFromToken(token) } });
      expect(count).toBe(1);

      const stockAfter = (await prisma.productVariant.findUnique({ where: { id: variantId } })).stock;
      expect(stockBefore - stockAfter).toBe(1);
    });

    it('la clave es por usuario: dos cuentas pueden usar la misma', async () => {
      const key = 'compartida-entre-cuentas';

      const tokenA = await registerAndLogin('idem-cuenta-a');
      const tokenB = await registerAndLogin('idem-cuenta-b');

      for (const token of [tokenA, tokenB]) {
        await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 1 }, token);

        const res = await postWithKey(
          `${api}/orders`,
          { shippingAddress: address, paymentMethod: 'CARD' },
          token,
          key
        );

        // Ambas son compras nuevas: la unicidad es (userId, clave), no la clave sola.
        expect(res.status).toBe(201);
      }
    });

    it('una clave con formato inválido se ignora en vez de romperse', async () => {
      const token = await registerAndLogin('idem-basura');
      await post(`${api}/cart/items`, { variantId: product.variants[0].id, quantity: 1 }, token);

      const res = await postWithKey(
        `${api}/orders`,
        { shippingAddress: address, paymentMethod: 'CARD' },
        token,
        'no valida!!'
      );

      // Se trata como si no hubiera cabecera: la compra se hace normal.
      expect(res.status).toBe(201);
    });
  });

  it('crea el pedido, descuenta el stock y vacía el carrito', async () => {
    const before = await prisma.productVariant.findUnique({
      where: { id: product.variants[0].id }
    });

    const res = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD', notes: 'Entregar por la tarde' },
      customerToken
    );

    expect(res.status).toBe(201);
    expect(res.body.data.orderNumber).toMatch(/^EXT-\d{4}-[0-9A-F]{8}$/);
    expect(res.body.data.status).toBe('PENDING');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].productName).toBe(product.name);
    expect(res.body.data.items[0].sku).toBe(product.variants[0].sku);

    // Totales: 80 + 4,90 de envío + 16,80 de IVA de los productos + 1,03 del IVA del envío
    expect(res.body.data.totals).toMatchObject({
      subtotal: 80,
      discount: 0,
      shipping: 4.9,
      tax: 17.83,
      total: 102.73
    });

    const after = await prisma.productVariant.findUnique({
      where: { id: product.variants[0].id }
    });
    expect(before.stock - after.stock).toBe(2);

    const cart = (await get(`${api}/cart`, customerToken)).body.data;
    expect(cart.items).toEqual([]);
  });

  it('crea el pago en estado PENDING y guarda la dirección copiada', async () => {
    const res = await get(`${api}/orders`, customerToken);
    const order = res.body.data[0];

    const detail = (await get(`${api}/orders/${order.orderNumber}`, customerToken)).body.data;

    expect(detail.payments[0]).toMatchObject({ method: 'CARD', status: 'PENDING' });
    expect(detail.shippingAddress.city).toBe('Madrid');
    expect(detail.notes).toBeTruthy();
    expect(detail.timeline[0]).toMatchObject({ key: 'placed', done: true });
  });

  it('no deja comprar con el carrito vacío', async () => {
    const res = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD' },
      customerToken
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/vacío/i);
  });

  it('aplica el cupón y consume su contador', async () => {
    await post(`${api}/cart/items`, { variantId: product.variants[0].id }, customerToken);

    const couponBefore = await prisma.coupon.findUnique({ where: { code: 'BIENVENIDA10' } });
    const res = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD', couponCode: 'bienvenida10' },
      customerToken
    );

    expect(res.status).toBe(201);
    expect(res.body.data.totals.discount).toBe(4); // 10 % de 40 €

    const couponAfter = await prisma.coupon.findUnique({ where: { code: 'BIENVENIDA10' } });
    expect(couponAfter.usedCount).toBe(couponBefore.usedCount + 1);

    // El pedido guarda el código aunque el cupón se borre después.
    expect(res.body.data.couponCode).toBe('BIENVENIDA10');
  });

  it('rechaza el pago si el stock se agotó entre el carrito y el checkout', async () => {
    const variantId = product.variants[0].id;
    const before = await prisma.productVariant.findUnique({ where: { id: variantId } });

    await post(`${api}/cart/items`, { variantId, quantity: 2 }, customerToken);

    // Alguien se lleva el stock por otra vía.
    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: 1 } });

    const res = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD' },
      customerToken
    );

    // Se repone el stock ANTES de assertar: si el test falla aquí, no puede
    // dejar el catálogo de la suite en un estado que rompa los siguientes.
    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: before.stock } });

    expect(res.status).toBe(409);
    expect(res.body.errors.code).toBe('OUT_OF_STOCK');
    expect(res.body.errors.sku).toBe(before.sku);

    await del(`${api}/cart`, customerToken);
  });

  it('no cobra un cupón si falla el stock (todo o nada)', async () => {
    // Usuario nuevo: BIENVENIDA10 solo se puede usar una vez por persona.
    const user = await registerAndLogin('atomic');
    const variantId = product.variants[0].id;
    await post(`${api}/cart/items`, { variantId, quantity: 1 }, user);

    const couponBefore = await prisma.coupon.findUnique({ where: { code: 'BIENVENIDA10' } });
    const stockBefore = await prisma.productVariant.findUnique({ where: { id: variantId } });

    await prisma.productVariant.update({ where: { id: variantId }, data: { stock: 0 } });

    const res = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD', couponCode: 'bienvenida10' },
      user
    );

    // Reponer antes de assertar, por el mismo motivo que en el test anterior.
    await prisma.productVariant.update({
      where: { id: variantId },
      data: { stock: stockBefore.stock }
    });

    const couponAfter = await prisma.coupon.findUnique({ where: { code: 'BIENVENIDA10' } });
    const orders = await prisma.order.count({
      where: { userId: res.body?.data?.id ?? '', status: 'PENDING' }
    });

    expect(res.status).toBe(409);
    expect(couponAfter.usedCount).toBe(couponBefore.usedCount); // el cupón no se consumió
    expect(orders).toBe(0); // y no quedó ningún pedido a medias

    await del(`${api}/cart`, user);
  });
});

// ── Consulta y cancelación ───────────────────────────────────────────────────

describe('Pedidos del cliente', () => {
  it('lista el historial paginado y en orden inverso', async () => {
    const res = await get(`${api}/orders?page=1&perPage=2`, customerToken);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeLessThanOrEqual(2);
    expect(res.body.meta.total).toBeGreaterThan(0);
    expect(res.body.data[0].orderNumber).toMatch(/^EXT-/);
  });

  it('busca por número legible y por id', async () => {
    const list = (await get(`${api}/orders`, customerToken)).body.data;
    const order = list[0];

    expect((await get(`${api}/orders/${order.orderNumber}`, customerToken)).status).toBe(200);
    expect((await get(`${api}/orders/${order.id}`, customerToken)).status).toBe(200);
  });

  it('no deja ver el pedido de otro usuario (404, no 403)', async () => {
    const list = (await get(`${api}/orders`, customerToken)).body.data;

    const res = await get(`${api}/orders/${list[0].orderNumber}`, otherToken);

    expect(res.status).toBe(404);
    expect(res.body.message).toMatch(/no hemos encontrado/i);
  });

  it('devuelve 404 con un pedido inexistente', async () => {
    expect((await get(`${api}/orders/EXT-2020-XXXXXXXX`, customerToken)).status).toBe(404);
  });

  it('cancela un pedido pendiente y repone el stock', async () => {
    const variantId = product.variants[0].id;
    await post(`${api}/cart/items`, { variantId, quantity: 2 }, customerToken);

    const stockBefore = await prisma.productVariant.findUnique({ where: { id: variantId } });
    const created = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'TRANSFER' },
      customerToken
    );

    const res = await post(
      `${api}/orders/${created.body.data.orderNumber}/cancel`,
      { reason: 'Me he equivocado de talla' },
      customerToken
    );

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(res.body.data.timeline.at(-1).key).toBe('cancelled');

    const stockAfter = await prisma.productVariant.findUnique({ where: { id: variantId } });
    // Comprar (2 menos) y cancelar (2 más) deja el stock donde estaba.
    expect(stockAfter.stock).toBe(stockBefore.stock);

    const payment = await prisma.payment.findFirst({
      where: { orderId: created.body.data.id }
    });
    expect(payment.status).toBe('FAILED');
  });

  it('no deja cancelar dos veces ni cancelar un pedido ya pagado', async () => {
    const list = (await get(`${api}/orders`, customerToken)).body.data;
    const cancelled = list.find((order) => order.status === 'CANCELLED');

    const again = await post(
      `${api}/orders/${cancelled.orderNumber}/cancel`,
      { reason: 'Otra vez' },
      customerToken
    );
    expect(again.status).toBe(409);

    const pending = list.find((order) => order.status === 'PENDING');
    await prisma.order.update({
      where: { id: pending.id },
      data: { status: 'PAID', paidAt: new Date() }
    });

    const paid = await post(
      `${api}/orders/${pending.orderNumber}/cancel`,
      { reason: 'Me arrepiento' },
      customerToken
    );
    expect(paid.status).toBe(409);
    expect(paid.body.message).toMatch(/devol/i);
  });

  it('con dos cancelaciones simultáneas repone el stock una sola vez', async () => {
    // Doble clic, o el mismo usuario en dos pestañas. Las dos peticiones salen
    // a la vez: si el estado se comprobará fuera de la transacción, las dos
    // entrarían y reponerían stock dos veces (inventario fantasma). Con el
    // compare-and-swap sobre `status = 'PENDING'` solo una gana.
    const user = await registerAndLogin('doble-cancel');
    const variantId = product.variants[0].id;
    await post(`${api}/cart/items`, { variantId, quantity: 2 }, user);

    const stockBefore = await prisma.productVariant.findUnique({ where: { id: variantId } });
    const created = await post(
      `${api}/orders`,
      { shippingAddress: address, paymentMethod: 'CARD' },
      user
    );
    const key = created.body.data.orderNumber;

    const [a, b] = await Promise.all([
      post(`${api}/orders/${key}/cancel`, { reason: 'Doble clic' }, user),
      post(`${api}/orders/${key}/cancel`, { reason: 'Doble clic' }, user)
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]); // una gana, la otra recibe 409

    const stockAfter = await prisma.productVariant.findUnique({ where: { id: variantId } });
    expect(stockAfter.stock).toBe(stockBefore.stock); // y solo se repuso una vez

    const order = await prisma.order.findUnique({ where: { id: created.body.data.id } });
    expect(order.status).toBe('CANCELLED');
    expect(order.cancelledAt).not.toBeNull();
  });

  it('exige un motivo para cancelar', async () => {
    const list = (await get(`${api}/orders`, customerToken)).body.data;
    const res = await post(
      `${api}/orders/${list[0].orderNumber}/cancel`,
      { reason: '' },
      customerToken
    );

    expect(res.status).toBe(422);
  });
});
