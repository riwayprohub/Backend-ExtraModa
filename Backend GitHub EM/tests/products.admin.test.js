import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

const PRODUCTS = '/api/v1/products';

// Todos los datos que crea esta suite comparten prefijo de SKU. La limpieza
// va por prefijo y NO por una lista de ids: si un test revienta a mitad, sus
// filas se cuelan igual en la lista y ensucian la base de datos para siempre.
const TEST_PREFIX = 'TST-';
const created = []; // ids, solo para las aserciones

// Cada test que necesita un SKU propio inventa el suyo (para probar duplicados,
// variantes heredadas, shortages...). La purga tiene que conocerlos todos: si
// se queda fuera uno, el producto sobrevive a la suite y se acumula en el
// catálogo de desarrollo. Se purga por prefijo y no por id, porque un test que
// falla a medias puede no haber guardado el id.
const TEST_SKU_PREFIXES = ['TST-', 'DUP-', 'PADRE-', 'STK-', 'VAR-', 'ALT-', 'ABS-', 'NEG-', 'BUS-'];

let adminToken;
let customerToken;

// Sesiones reales vía API: el token se obtiene como lo haría el frontend.
async function tokenFor(email, password) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken;
}

const withAuth = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

const newProduct = (overrides = {}) => ({
  name: `Vaquero Test ${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  sku: `${TEST_PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
  description: 'Vaquero de prueba creado por la suite de administración.',
  basePrice: 79.9,
  ...overrides
});

const purgeTestProducts = () =>
  prisma.product.deleteMany({
    where: { OR: TEST_SKU_PREFIXES.map((prefix) => ({ sku: { startsWith: prefix } })) }
  });

beforeAll(async () => {
  // Runs anteriores pueden haber dejado productos a medias.
  await purgeTestProducts();
  adminToken = await tokenFor('admin@extramoda.es', 'Password123!');
  customerToken = await tokenFor('cliente@ejemplo.com', 'Password123!');
});

afterAll(async () => {
  await purgeTestProducts();
});

// ── Autorización ─────────────────────────────────────────────────────────────

describe('Escrituras de producto: control de acceso', () => {
  it('rechaza sin token con 401', async () => {
    const res = await request(app).post(PRODUCTS).send(newProduct());
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHORIZED');
  });

  it('rechaza a un CUSTOMER con 403', async () => {
    const res = await withAuth('post', PRODUCTS, customerToken).send(newProduct());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('rechaza a un CUSTOMER también en PATCH y DELETE', async () => {
    const patch = await withAuth('patch', `${PRODUCTS}/cualquiera`, customerToken).send({ isFeatured: true });
    const remove = await withAuth('delete', `${PRODUCTS}/cualquiera`, customerToken);

    expect(patch.status).toBe(403);
    expect(remove.status).toBe(403);
  });

  it('no filtra si el producto existe cuando el rol es insuficiente', async () => {
    // 403 y no 404: el rol ya está comprobado antes de tocar la BD.
    const res = await withAuth('delete', `${PRODUCTS}/no-existe-este-slug`, customerToken);
    expect(res.status).toBe(403);
    expect(res.body.message).not.toMatch(/no existe/i);
  });

  it('devuelve 404 a un ADMIN cuando el producto no existe', async () => {
    const res = await withAuth('patch', `${PRODUCTS}/no-existe-este-slug`, adminToken).send({ isFeatured: true });
    expect(res.status).toBe(404);
  });
});

// ── Alta ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/products', () => {
  it('crea el producto con variantes y calcula currentPrice', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ basePrice: 79.9, salePrice: 59.9 })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.currentPrice).toBe(59.9);
    expect(res.body.data.slug).toMatch(/^vaquero-test-\w+/);
    created.push(res.body.data.id);

    // Sin venta, currentPrice = basePrice
    const plain = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ basePrice: 45, salePrice: undefined }));
    expect(plain.body.data.currentPrice).toBe(45);
    created.push(plain.body.data.id);
  });

  it('persiste currentPrice en la BD (no solo en la respuesta)', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ basePrice: 30, salePrice: 24.5 }));
    const row = await prisma.product.findUnique({ where: { id: res.body.data.id }, select: { currentPrice: true } });

    expect(Number(row.currentPrice)).toBe(24.5);
    created.push(res.body.data.id);
  });

  it('crea variantes anidadas heredando el precio del producto', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({
        basePrice: 50,
        variants: [
          { sku: `VAR-${Date.now()}-A`, stock: 5 },
          { sku: `VAR-${Date.now()}-B`, price: 45, stock: 2 }
        ]
      })
    );

    expect(res.status).toBe(201);
    const [first, second] = res.body.data.variants;
    expect(first.price).toBe(50); // heredado
    expect(second.price).toBe(45); // explícito
    expect(first.stock).toBe(5);
    created.push(res.body.data.id);
  });

  it('las variantes heredan también la oferta del producto', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ basePrice: 129.95, salePrice: 99.5, variants: [{ stock: 2 }] })
    );

    expect(res.status).toBe(201);
    const variant = res.body.data.variants[0];
    // Sin esto, la ficha mostraría 99,50 € y al elegir talla, 129,95 €.
    expect(variant.basePrice).toBe(129.95);
    expect(variant.salePrice).toBe(99.5);
    expect(variant.compareAtPrice).toBe(129.95);
    expect(variant.price).toBe(99.5);
    expect(variant.price).toBe(res.body.data.price);
    created.push(res.body.data.id);
  });

  it('una variante con precio propio NO hereda la oferta', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ basePrice: 100, salePrice: 80, variants: [{ stock: 2, price: 90 }] })
    );

    expect(res.body.data.variants[0].basePrice).toBe(90);
    expect(res.body.data.variants[0].salePrice).toBeNull();
    created.push(res.body.data.id);
  });

  it('rechaza oferta mayor o igual que el precio base con 422', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ basePrice: 20, salePrice: 20 }));

    expect(res.status).toBe(422);
    expect(res.body.errors.salePrice).toMatch(/menor/i);
  });

  it('rechaza SKU duplicado con 409', async () => {
    const sku = `DUP-${Date.now()}`;
    const first = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ sku }));
    created.push(first.body.data.id);

    const second = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ sku }));

    expect(second.status).toBe(409);
    expect(second.body.code).toBe('DUPLICATE');
  });

  it('rechaza color o talla inexistentes con 400', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ variants: [{ stock: 1, colorValueId: 'clxxxxxxxxxxxxxxxxxx' }] })
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inexistente/i);
  });

  it('el panel ve costPrice, el cliente no', async () => {
    const res = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ status: 'ACTIVE', variants: [{ stock: 1, costPrice: 12.34 }] })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.variants[0].costPrice).toBe(12.34); // dato del panel
    created.push(res.body.data.id);

    // El mismo producto, leído por la vía pública, no lo revela.
    const publicView = await request(app).get(`${PRODUCTS}/${res.body.data.slug}`);
    expect(publicView.status).toBe(200);
    expect(JSON.stringify(publicView.body)).not.toContain('costPrice');
    expect(JSON.stringify(publicView.body)).not.toContain('12.34');
  });
});

// ── Modificación ─────────────────────────────────────────────────────────────

describe('PATCH /api/v1/products/:key', () => {
  it('actualiza campos y recalcula currentPrice', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ basePrice: 30 }));
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({ salePrice: 21.5 });

    expect(res.status).toBe(200);
    expect(res.body.data.currentPrice).toBe(21.5);
    expect(res.body.data.basePrice).toBe(30);
  });

  it('mantiene el slug aunque cambie el nombre (URLs indexadas)', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(created_.body.data.id);
    const originalSlug = created_.body.data.slug;

    const res = await withAuth('patch', `${PRODUCTS}/${originalSlug}`, adminToken).send({
      name: 'Nombre Completamente Distinto'
    });

    expect(res.status).toBe(200);
    expect(res.body.data.slug).toBe(originalSlug);
    expect(res.body.data.name).toBe('Nombre Completamente Distinto');
  });

  it('quita la oferta con salePrice: null y recalcula currentPrice', async () => {
    // Desde el panel, vaciar el campo de oferta tiene que poder desactivarla.
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ basePrice: 50, salePrice: 39.9 })
    );
    created.push(created_.body.data.id);
    expect(created_.body.data.currentPrice).toBe(39.9);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({
      salePrice: null
    });

    expect(res.status).toBe(200);
    expect(res.body.data.salePrice).toBeNull();
    expect(res.body.data.basePrice).toBe(50);
    expect(res.body.data.currentPrice).toBe(50);

    const row = await prisma.product.findUnique({ where: { id: created_.body.data.id }, select: { salePrice: true, currentPrice: true } });
    expect(row.salePrice).toBeNull();
    expect(Number(row.currentPrice)).toBe(50);
  });

  it('rechaza un body vacío con 422', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({});

    expect(res.status).toBe(422);
  });

  it('impide bajar el precio base por debajo de las variantes existentes', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ basePrice: 100, variants: [{ sku: `ALT-${Date.now()}`, price: 90, stock: 1 }] })
    );
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({ basePrice: 50 });

    expect(res.status).toBe(409);
    expect(res.body.errors.conflictingVariants).toHaveLength(1);
  });

  it('reactiva un producto archivado con fecha de publicación', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'DRAFT' }));
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({ status: 'ACTIVE' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.publishedAt).toBeTruthy();
  });

  it('permite editar un producto archivado (el archivado es reversible)', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(created_.body.data.id);
    await withAuth('delete', `${PRODUCTS}/${created_.body.data.slug}`, adminToken);

    const res = await withAuth('patch', `${PRODUCTS}/${created_.body.data.slug}`, adminToken).send({ isFeatured: true });

    expect(res.status).toBe(200);
  });
});

// ── Variantes y stock ────────────────────────────────────────────────────────

describe('Variantes y stock', () => {
  it('añade una variante con SKU automático heredando el precio', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ basePrice: 88.5, sku: `PADRE-${Date.now()}` }));
    created.push(product.body.data.id);

    const res = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/variants`, adminToken).send({ stock: 3 });

    expect(res.status).toBe(201);
    expect(res.body.data.sku).toContain('PADRE');
    expect(res.body.data.price).toBe(88.5);
    expect(res.body.data.inStock).toBe(true);
  });

  it('ajusta stock con delta y devuelve el valor anterior', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ variants: [{ sku: `STK-${Date.now()}`, stock: 10 }] })
    );
    created.push(product.body.data.id);
    const variant = product.body.data.variants[0];

    const res = await withAuth('patch', `${PRODUCTS}/variants/${variant.id}/stock`, adminToken).send({ delta: 5 });

    expect(res.status).toBe(200);
    expect(res.body.data.previousStock).toBe(10);
    expect(res.body.data.stock).toBe(15);
  });

  it('acepta un valor absoluto de stock', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ variants: [{ sku: `ABS-${Date.now()}`, stock: 10 }] })
    );
    created.push(product.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/variants/${product.body.data.variants[0].id}/stock`, adminToken).send({
      stock: 0
    });

    expect(res.status).toBe(200);
    expect(res.body.data.stock).toBe(0);
    expect(res.body.data.inStock).toBe(false);
  });

  it('impide dejar el stock en negativo con 409', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(
      newProduct({ variants: [{ sku: `NEG-${Date.now()}`, stock: 3 }] })
    );
    created.push(product.body.data.id);

    const res = await withAuth('patch', `${PRODUCTS}/variants/${product.body.data.variants[0].id}/stock`, adminToken).send({
      delta: -50
    });

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/negativo/i);
  });

  it('rechaza delta y stock a la vez', async () => {
    const res = await withAuth('patch', `${PRODUCTS}/variants/cualquiera/stock`, adminToken).send({ delta: 1, stock: 2 });
    expect(res.status).toBe(422);
  });

  it('devuelve 404 al ajustar una variante inexistente', async () => {
    const res = await withAuth('patch', `${PRODUCTS}/variants/cualquiera/stock`, adminToken).send({ delta: 1 });
    expect(res.status).toBe(404);
  });
});

// ── Baja ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/products/:key', () => {
  it('archiva en lugar de borrar, y desaparece del catálogo público', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'ACTIVE' }));
    const { slug } = product.body.data;

    const del = await withAuth('delete', `${PRODUCTS}/${slug}`, adminToken);
    expect(del.status).toBe(200);
    expect(del.body.data.status).toBe('ARCHIVED');

    const publicView = await request(app).get(`${PRODUCTS}/${slug}`);
    expect(publicView.status).toBe(404);
  });

  it('un EDITOR no puede archivar (reservado a ADMIN)', async () => {
    const res = await withAuth('delete', `${PRODUCTS}/lo-que-sea`, customerToken);
    expect(res.status).toBe(403);
  });

  it('borra de verdad con ?hard=true si no hay pedidos', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());

    const res = await withAuth('delete', `${PRODUCTS}/${product.body.data.slug}?hard=true`, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();

    const row = await prisma.product.findUnique({ where: { id: product.body.data.id } });
    expect(row).toBeNull();
  });
});

// ── Imágenes ─────────────────────────────────────────────────────────────────

describe('POST /api/v1/products/:key/images', () => {
  // 1x1 PNG real: un Buffer cualquiera would fall in image sniffing.
  const pngBuffer = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  it('sube una imagen, la guarda en MySQL y devuelve su ruta pública', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(product.body.data.id);

    const res = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/images`, adminToken)
      .attach('image', pngBuffer, { filename: 'camiseta.png', contentType: 'image/png' })
      .field('altText', 'Camiseta de algodón');

    expect(res.status).toBe(201);
    // La URL apunta al endpoint de la API, no a /uploads: el binario vive en
    // MySQL porque el disco de Render Free no sobrevive a un reinicio.
    expect(res.body.data.url).toMatch(/^\/api\/v1\/images\/[0-9a-f-]{36}$/);
    expect(res.body.data.altText).toBe('Camiseta de algodón');

    const row = await prisma.productImage.findUnique({ where: { id: res.body.data.id } });
    expect(row.productId).toBe(product.body.data.id);
    expect(row.mime).toBe('image/png');
    expect(row.bytes).toBe(pngBuffer.length);
    expect(Buffer.from(row.data).equals(pngBuffer)).toBe(true);
  });

  it('sirve la imagen desde la API con su content-type', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(product.body.data.id);

    const uploaded = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/images`, adminToken)
      .attach('image', pngBuffer, { filename: 'camiseta.png', contentType: 'image/png' });

    const res = await request(app).get(uploaded.body.data.url);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(res.headers['cache-control']).toContain('immutable');
    // El binario devuelto debe ser byte a byte el que se subió.
    expect(Buffer.from(res.body).equals(pngBuffer)).toBe(true);
  });

  it('devuelve 404 con un id de imagen inexistente o mal formado', async () => {
    const missing = await request(app).get('/api/v1/images/11111111-1111-4111-8111-111111111111');
    expect(missing.status).toBe(404);

    const invalid = await request(app).get('/api/v1/images/no-es-un-uuid');
    expect(invalid.status).toBe(422);
  });

  it('rechaza un tipo no permitido con 400', async () => {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(product.body.data.id);

    const res = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/images`, adminToken).attach(
      'image',
      Buffer.from('#!/bin/sh\necho hack'),
      { filename: 'script.svg', contentType: 'image/svg+xml' }
    );

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/formato no permitido/i);
  });

  it('exige autenticación para subir', async () => {
    const res = await request(app)
      .post(`${PRODUCTS}/lo-que-sea/images`)
      .attach('image', pngBuffer, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(401);
  });
});

// ── Listado del panel ────────────────────────────────────────────────────────

describe('GET /api/v1/products/manage', () => {
  it('muestra DRAFT y ARCHIVED que el listado público oculta', async () => {
    const draft = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'DRAFT' }));
    const archived = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'ARCHIVED' }));
    created.push(draft.body.data.id, archived.body.data.id);

    const manage = await withAuth('get', `${PRODUCTS}/manage?perPage=60`, adminToken);
    expect(manage.status).toBe(200);
    const ids = manage.body.data.map((product) => product.id);
    expect(ids).toContain(draft.body.data.id);
    expect(ids).toContain(archived.body.data.id);

    // El mismo producto, por la vía pública, no aparece.
    const publicList = await request(app).get(`${PRODUCTS}?perPage=60`);
    expect(publicList.body.data.map((product) => product.id)).not.toContain(draft.body.data.id);
  });

  it('filtra por estado', async () => {
    const draft = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'DRAFT' }));
    created.push(draft.body.data.id);

    const res = await withAuth('get', `${PRODUCTS}/manage?status=DRAFT&perPage=60`, adminToken);
    expect(res.body.data.every((product) => product.status === 'DRAFT')).toBe(true);
    expect(res.body.data.map((product) => product.id)).toContain(draft.body.data.id);
  });

  it('busca por nombre y por SKU', async () => {
    const sku = `BUS-${Date.now()}`;
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ sku }));
    created.push(created_.body.data.id);

    const byName = await withAuth('get', `${PRODUCTS}/manage?q=${encodeURIComponent(created_.body.data.name)}`, adminToken);
    expect(byName.body.data.map((p) => p.id)).toContain(created_.body.data.id);

    const bySku = await withAuth('get', `${PRODUCTS}/manage?q=${sku}`, adminToken);
    expect(bySku.body.data.map((p) => p.id)).toContain(created_.body.data.id);
  });

  it('expone el id de imagen en el DTO de admin, para poder borrarla', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64'
    );
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'ACTIVE' }));
    created.push(product.body.data.id);

    const uploaded = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/images`, adminToken)
      .attach('image', png, { filename: 'foto.png', contentType: 'image/png' });
    expect(uploaded.status).toBe(201);

    const manage = await withAuth('get', `${PRODUCTS}/manage?q=${encodeURIComponent(product.body.data.name)}`, adminToken);
    const found = manage.body.data.find((item) => item.id === product.body.data.id);

    expect(found.images[0].id).toBe(uploaded.body.data.id);

    // El DTO público sigue sin exponer el id.
    const publicView = await request(app).get(`${PRODUCTS}/${product.body.data.slug}`);
    expect(publicView.body.data.product.images[0].id).toBeUndefined();
  });

  it('rechaza a un CUSTOMER con 403 y sin token con 401', async () => {
    const customer = await withAuth('get', `${PRODUCTS}/manage`, customerToken);
    expect(customer.status).toBe(403);

    const anon = await request(app).get(`${PRODUCTS}/manage`);
    expect(anon.status).toBe(401);
  });
});

// ── Detalle del panel ─────────────────────────────────────────────────────────

describe('GET /api/v1/products/manage/:key', () => {
  it('devuelve un borrador que la vía pública no encuentra', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct({ status: 'DRAFT' }));
    created.push(created_.body.data.id);

    const res = await withAuth('get', `${PRODUCTS}/manage/${created_.body.data.slug}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(created_.body.data.id);
    expect(res.body.data.status).toBe('DRAFT');
    expect(res.body.data.basePrice).toBe(created_.body.data.basePrice);

    // Por la vía pública, ese mismo slug no existe.
    const publicView = await request(app).get(`${PRODUCTS}/${created_.body.data.slug}`);
    expect(publicView.status).toBe(404);
  });

  it('acepta el id además del slug', async () => {
    const created_ = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    created.push(created_.body.data.id);

    const res = await withAuth('get', `${PRODUCTS}/manage/${created_.body.data.id}`, adminToken);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(created_.body.data.id);
  });

  it('devuelve 404 con una referencia inexistente', async () => {
    const res = await withAuth('get', `${PRODUCTS}/manage/no-existe-este-slug`, adminToken);
    expect(res.status).toBe(404);
  });

  it('rechaza a un CUSTOMER con 403', async () => {
    const res = await withAuth('get', `${PRODUCTS}/manage/lo-que-sea`, customerToken);
    expect(res.status).toBe(403);
  });
});

// ── Borrado de imágenes ───────────────────────────────────────────────────────

describe('DELETE /api/v1/products/images/:imageId', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );

  /** Sube una imagen a un producto nuevo y devuelve { product, image }. */
  async function uploadImage() {
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    const uploaded = await withAuth('post', `${PRODUCTS}/${product.body.data.slug}/images`, adminToken)
      .attach('image', png, { filename: 'foto.png', contentType: 'image/png' });

    expect(uploaded.status).toBe(201);
    return { product: product.body.data, image: uploaded.body.data };
  }

  it('borra la imagen por su id y deja de servirse', async () => {
    const { product, image } = await uploadImage();

    const res = await withAuth('delete', `${PRODUCTS}/images/${image.id}`, adminToken);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(image.id);

    const row = await prisma.productImage.findUnique({ where: { id: image.id } });
    expect(row).toBeNull();

    const served = await request(app).get(image.url);
    expect(served.status).toBe(404);
  });

  it('borra también las imágenes de seed (URL externa, sin binario)', async () => {
    // Cualquier producto del catálogo sembrado tiene al menos una imagen con
    // url externa. Se crea una fila equivalente para no depender del seed.
    const product = await withAuth('post', PRODUCTS, adminToken).send(newProduct());
    const external = await prisma.productImage.create({
      data: {
        productId: product.body.data.id,
        url: 'https://ejemplo.invalid/foto.jpg',
        position: 0
      },
      select: { id: true }
    });
    created.push(product.body.data.id);

    const res = await withAuth('delete', `${PRODUCTS}/images/${external.id}`, adminToken);

    expect(res.status).toBe(200);
    const row = await prisma.productImage.findUnique({ where: { id: external.id } });
    expect(row).toBeNull();
  });

  it('devuelve 404 con un id válido inexistente', async () => {
    const res = await withAuth('delete', `${PRODUCTS}/images/11111111-1111-4111-8111-111111111111`, adminToken);
    expect(res.status).toBe(404);
  });

  it('rechaza un id con formato inválido con 422', async () => {
    const res = await withAuth('delete', `${PRODUCTS}/images/no_es_un_uuid!!!`, adminToken);
    expect(res.status).toBe(422);
  });

  it('exige autenticación y rechaza a un CUSTOMER con 403', async () => {
    const anon = await request(app).delete(`${PRODUCTS}/images/11111111-1111-4111-8111-111111111111`);
    expect(anon.status).toBe(401);

    const customer = await withAuth('delete', `${PRODUCTS}/images/11111111-1111-4111-8111-111111111111`, customerToken);
    expect(customer.status).toBe(403);
  });
});
