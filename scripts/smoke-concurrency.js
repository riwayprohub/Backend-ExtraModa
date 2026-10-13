/**
 * Smoke de concurrencia contra el servidor real: lo que un usuario hace con dos
 * dedos (o con dos pestañas) no debe romper nada.
 *
 *   npm run dev
 *   node scripts/smoke-concurrency.js
 */

const api = 'http://localhost:3000/api/v1';

async function call(method, path, { token, body, idempotencyKey } = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const json = await res.json().catch(() => ({}));
  return { status: res.status, ...json };
}

const money = (value) => `${value.toFixed(2).replace('.', ',')} €`;
const check = (label, ok, detail = '') =>
  console.log(`  ${ok ? 'OK  ' : 'FALLA'} ${label}${detail ? ` - ${detail}` : ''}`);

/**
 * El stock se lee de la base y no de la API a proposito: el DTO publico expone
 * `stockAvailable` (stock menos reservado), no el stock real, y comparar
 * `undefined === undefined` daria un OK falso.
 */
async function variantStock(variantId) {
  const { prisma } = await import('../src/config/database.js');
  const row = await prisma.productVariant.findUnique({
    where: { id: variantId },
    select: { stock: true }
  });
  return row.stock;
}

const email = `smoke.${Date.now()}@ejemplo.com`;
const address = {
  firstName: 'Luis',
  lastName: 'Gomez',
  line1: 'Calle Sol 5',
  city: 'Valencia',
  province: 'Valencia',
  postalCode: '46001'
};

// -- Doble "anadir al carrito" con la misma variante ---------------------------

console.log('\n1. Doble clic en "anadir al carrito" (misma variante)');

const registered = await call('POST', '/auth/register', {
  body: { firstName: 'Luis', lastName: 'Gomez', email, password: 'Password123' }
});
const token = registered.data.accessToken;

// Producto propio, como hace la suite de tests: un smoke que descuenta stock
// real sobre el catalogo del seed deja el catalogo de desarrollo con numeros
// que no cuadran, y ademas se queda sin unidades para la segunda ejecucion.
const login = await call('POST', '/auth/login', {
  body: { email: 'admin@extramoda.es', password: 'Password123!' }
});
const adminToken = login.data.accessToken;

const stamp = Date.now();
const created = await call('POST', '/products', {
  token: adminToken,
  body: {
    name: `Smoke Concurrencia ${stamp}`,
    sku: `SMK${stamp}`,
    description: 'Producto temporal del smoke de concurrencia.',
    basePrice: 40,
    status: 'ACTIVE',
    variants: [{ stock: 50 }]
  }
});
const product = created.data;
const variant = product.variants[0];

const adds = await Promise.all([
  call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 1 } }),
  call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 2 } })
]);
check(
  'las dos peticiones responden 201',
  adds.every((r) => r.status === 201),
  adds.map((r) => r.status).join(' / ')
);

const cart = await call('GET', '/cart', { token });
check(
  'una sola linea con 3 unidades',
  cart.data.items.length === 1 && cart.data.items[0].quantity === 3,
  `${cart.data.items.length} linea(s), cantidad ${cart.data.items[0].quantity}`
);

// -- Doble clic en "finalizar compra" ------------------------------------------

console.log('\n2. Dos checkouts simultaneos con un cupon de 1 uso por persona');

await call('DELETE', '/cart', { token });
await call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 1 } });
const applied = await call('POST', '/cart/coupon', { token, body: { code: 'bienvenida10' } });
check('cupon aplicado', applied.status === 200, `descuento ${money(applied.data.totals.discount)}`);

const buy = async () => {
  await call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 1 } });
  return call('POST', '/orders', {
    token,
    body: { shippingAddress: address, paymentMethod: 'CARD', couponCode: 'BIENVENIDA10' }
  });
};
const [first, second] = await Promise.all([buy(), buy()]);
const ok = [first, second].filter((r) => r.status === 201);
const ko = [first, second].filter((r) => r.status !== 201);
check('solo un pedido con descuento', ok.length === 1, `${ok.length} creado(s), ${ko.length} rechazado(s)`);

// El codigo del perdedor depende de donde se pierda la carrera: si su quote
// corre antes de que la primera confirme, el choque ocurre dentro de la
// transaccion; si corre despues, la validacion ya ve el uso y lo rechaza antes.
// Exigir solo uno de los dos hacia que este smoke fallara de forma aleatoria.
check(
  'el segundo recibe 409 por el cupon',
  ko[0]?.status === 409 && ['COUPON_LIMIT_REACHED', 'COUPON_INVALID'].includes(ko[0]?.errors?.code),
  `${ko[0]?.status} ${ko[0]?.errors?.code ?? ''}`
);

// -- Doble clic en "pagar" ------------------------------------------------------

console.log('\n3. Dos checkouts simultaneos con la MISMA clave de idempotencia');

await call('DELETE', '/cart', { token });
await call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 1 } });

const idemKey = `smoke-${Date.now()}`;
const stockBeforePay = await variantStock(variant.id);

const pay = () =>
  call('POST', '/orders', {
    token,
    idempotencyKey: idemKey,
    body: { shippingAddress: address, paymentMethod: 'TRANSFER' }
  });
const [p1, p2] = await Promise.all([pay(), pay()]);

check(
  'uno crea (201) y el otro recibe el mismo pedido (200)',
  [p1.status, p2.status].sort().join('/') === '200/201',
  `${p1.status} / ${p2.status}`
);
check(
  'los dos devuelven el MISMO pedido',
  p1.data?.orderNumber && p1.data.orderNumber === p2.data?.orderNumber,
  `${p1.data?.orderNumber} / ${p2.data?.orderNumber}`
);
check(
  'el stock se descuenta UNA vez',
  (await variantStock(variant.id)) === stockBeforePay - 1
);

// Un reintento manual, ya sin carrera, tampoco debe duplicar el pedido.
const retry = await pay();
check('el reintento devuelve 200', retry.status === 200, `${retry.status}`);
check(
  'y sigue siendo el mismo pedido',
  retry.data?.orderNumber === p1.data?.orderNumber,
  `${retry.data?.orderNumber}`
);

// -- Doble clic en "cancelar pedido" -------------------------------------------

console.log('\n4. Dos cancelaciones simultaneas del mismo pedido');

await call('DELETE', '/cart', { token });
await call('POST', '/cart/items', { token, body: { variantId: variant.id, quantity: 1 } });
const toCancel = await call('POST', '/orders', {
  token,
  body: { shippingAddress: address, paymentMethod: 'TRANSFER' }
});
const key = toCancel.data.orderNumber;

const stockBefore = await variantStock(variant.id);

const cancels = await Promise.all([
  call('POST', `/orders/${key}/cancel`, { token, body: { reason: 'doble clic' } }),
  call('POST', `/orders/${key}/cancel`, { token, body: { reason: 'doble clic' } })
]);
check(
  'una cancelacion gana y la otra recibe 409',
  cancels.filter((r) => r.status === 200).length === 1 &&
    cancels.filter((r) => r.status !== 200)[0]?.status === 409,
  cancels.map((r) => r.status).join(' / ')
);

const detail = await call('GET', `/orders/${key}`, { token });
check('el pedido queda CANCELLED', detail.data.status === 'CANCELLED', detail.data.status);
check(
  'el timeline marca el cancelado',
  detail.data.timeline.at(-1).key === 'cancelled',
  detail.data.timeline.map((s) => `${s.key}:${s.done ? 'hecho' : 'pendiente'}`).join(' -> ')
);

// El stock se leyo DESPUES de crear el pedido: en ese momento ya le falta 1
// unidad. Al cancelar debe volver a estar una unidad por encima, no igual.
const stockAfter = await variantStock(variant.id);
check(
  'el stock se repuso una sola vez',
  typeof stockAfter === 'number' && stockAfter === stockBefore + 1,
  `${stockBefore} + 1 esperado, ${stockAfter} (si se repusiera dos veces: ${stockBefore + 2})`
);

// -- Historial -----------------------------------------------------------------

console.log('\n5. Historial');
const history = await call('GET', '/orders', { token });
for (const order of history.data) {
  console.log(
    `  ${order.orderNumber}  ${order.status.padEnd(9)}  ${money(order.totals.total)}  ` +
      `${order.itemCount} art.  ${order.couponCode ?? 'sin cupon'}`
  );
}
// 3 pedidos: el del cupon, el del doble clic con clave y el que se cancela.
check('el historial devuelve todos los pedidos', history.data.length === 3, `${history.data.length} pedidos`);
check(
  'los totales cuadran con los importes mostrados',
  history.data.every(
    (o) =>
      Math.abs(o.totals.subtotal - o.totals.discount + o.totals.shipping + o.totals.tax - o.totals.total) <
      0.01
  )
);

// Ojo al borrar: `Order.userId` es Restrict a propósito (no se pierde un
// pedido), así que hay que borrar los pedidos del usuario antes que el usuario,
// y `OrderItem` es Restrict hacia Product, así que los pedidos se borran antes
// que el producto temporal.
const { prisma } = await import('../src/config/database.js');
const owner = await prisma.user.findUnique({ where: { email }, select: { id: true } });

if (owner) {
  await prisma.order.deleteMany({ where: { userId: owner.id } });
  await prisma.user.delete({ where: { email } });
  console.log('\nUsuario de prueba y sus pedidos borrados.');
}

await call('DELETE', `/products/${product.slug}?hard=true`, { token: adminToken });
console.log(`Producto temporal ${product.slug} borrado.`);

await prisma.$disconnect();
