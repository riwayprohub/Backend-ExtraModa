import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';
import { slugify } from '../src/utils/slugify.js';

/**
 * Fixtures propios: la tienda arranca SIN productos sembrados (el catálogo se
 * crea desde el panel), así que esta suite crea los suyos y los borra al
 * terminar. Antes se apoyaba en los del seed, que ya no existen.
 */

const PREFIX = 'LST-';
const api = '/api/v1/products';

let adminToken;
let colorValueId;
let sizeValueId;
let categoryId;
const createdIds = [];

const newProduct = (overrides = {}) => ({
  name: `Listado Test ${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  sku: `${PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
  description: 'Producto creado por la suite de listados del catálogo.',
  basePrice: 59.9,
  status: 'ACTIVE',
  ...overrides
});

async function createProduct(overrides = {}) {
  const res = await request(app)
    .post(api)
    .set('Authorization', `Bearer ${adminToken}`)
    .send(newProduct({ categoryId, ...overrides }));

  expect(res.status).toBe(201);
  createdIds.push(res.body.data.id);
  return res.body.data;
}

/** Publica el precio tachado/efectivo igual que la tienda: oferta < base. */
const discounted = (price) => Number((price * 0.8).toFixed(2));

beforeAll(async () => {
  adminToken = (
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@extramoda.es', password: 'Password123!' })
  ).body.data.accessToken;

  // Una variante con color y talla reales: sin ella, el filtro combinado no
  // tendría nada que encontrar y el test pasaría por vacío.
  const [color, size, category] = await Promise.all([
    prisma.attributeValue.findFirst({ where: { value: 'negro', attribute: { slug: 'color' } } }),
    prisma.attributeValue.findFirst({ where: { value: 'm', attribute: { slug: 'talla' } } }),
    prisma.category.findFirst({ where: { isActive: true } })
  ]);
  colorValueId = color?.id;
  sizeValueId = size?.id;
  categoryId = category?.id;

  await createProduct({
    name: 'Remera Lino Test',
    sku: `${PREFIX}A${Date.now()}`,
    basePrice: 20,
    variants: [
      { stock: 5, price: 20 },
      { stock: 2, price: 18 }
    ]
  });
  await createProduct({
    name: 'Blusa Negra Test',
    sku: `${PREFIX}T${Date.now()}`,
    basePrice: 45,
    variants: [{ stock: 6, colorValueId, sizeValueId }]
  });
  await createProduct({
    name: 'Vestido Sarga Test',
    sku: `${PREFIX}B${Date.now()}`,
    basePrice: 69.9,
    salePrice: discounted(69.9),
    variants: [{ stock: 3 }]
  });
  await createProduct({
    name: 'Jean Recto Test',
    sku: `${PREFIX}C${Date.now()}`,
    basePrice: 120,
    variants: [{ stock: 4 }]
  });
});

afterAll(async () => {
  // Los orderItems tienen Restrict hacia Product, pero esta suite no compra.
  await prisma.productImage.deleteMany({ where: { productId: { in: createdIds } } });
  await prisma.productVariant.deleteMany({ where: { productId: { in: createdIds } } });
  await prisma.product.deleteMany({ where: { id: { in: createdIds } } });
  await prisma.product.deleteMany({ where: { sku: { startsWith: PREFIX } } });
});

describe('GET /api/v1/products', () => {
  it('devuelve la primera página paginada', async () => {
    const res = await request(app).get(api).query({ perPage: 3 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeLessThanOrEqual(3);
    expect(res.body.meta).toMatchObject({ page: 1, perPage: 3 });
    expect(res.body.meta.total).toBeGreaterThan(0);
  });

  it('nunca expone costPrice en ningún nivel del JSON', async () => {
    const res = await request(app).get(api).query({ perPage: 50 });
    const serialized = JSON.stringify(res.body);

    expect(serialized).not.toContain('costPrice');
    expect(serialized).not.toContain('reservedStock');
  });

  it('filtra por talla y color en la MISMA variante', async () => {
    const res = await request(app).get(api).query({ sizes: 'm', colors: 'negro', perPage: 50 });

    expect(res.status).toBe(200);
    for (const product of res.body.data) {
      const variant = product.variants.find((v) => v.size?.value === 'm' && v.color?.value === 'negro');
      expect(variant).toBeDefined();
    }
  });

  it('devuelve vacío si la talla no existe, no todo el catálogo', async () => {
    const res = await request(app).get(api).query({ sizes: 'talla-inexistente-xyz' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.total).toBe(0);
  });

  it('busca por nombre', async () => {
    const res = await request(app).get(api).query({ q: 'Vestido' });

    expect(res.status).toBe(200);
    expect(res.body.meta.total).toBeGreaterThan(0);
    expect(res.body.data.every((product) => /vestido/i.test(product.name))).toBe(true);
  });

  it('ordena por precio ascendente', async () => {
    const res = await request(app).get(api).query({ sort: 'price_asc', perPage: 50 });
    const prices = res.body.data.map((product) => product.price);

    expect([...prices].sort((a, b) => a - b)).toEqual(prices);
  });

  it('ordena por precio descendente', async () => {
    const res = await request(app).get(api).query({ sort: 'price_desc', perPage: 50 });
    const prices = res.body.data.map((product) => product.price);

    expect([...prices].sort((a, b) => b - a)).toEqual(prices);
  });

  it('la columna current_price está sincronizada con COALESCE(sale, base)', async () => {
    const desincronizados = await prisma.$queryRaw`
      SELECT id, base_price, sale_price, current_price
      FROM products
      WHERE current_price <> COALESCE(sale_price, base_price)
    `;

    expect(desincronizados).toEqual([]);
  });

  it('filtra por rango de precio usando el precio efectivo', async () => {
    const res = await request(app).get(api).query({ minPrice: 50, maxPrice: 80, perPage: 50 });

    for (const product of res.body.data) {
      expect(product.price).toBeGreaterThanOrEqual(50);
      expect(product.price).toBeLessThanOrEqual(80);
    }
  });

  it('rechaza parámetros inválidos con 422 y errores por campo', async () => {
    const res = await request(app).get(api).query({ page: 0, minPrice: 100, maxPrice: 10 });

    expect(res.status).toBe(422);
    expect(res.body.code).toBe('VALIDATION_ERROR');
    expect(Object.keys(res.body.errors).length).toBeGreaterThan(0);
  });

  it('rechaza un término de búsqueda demasiado corto', async () => {
    const res = await request(app).get(api).query({ q: 'a' });
    expect(res.status).toBe(422);
  });
});

describe('GET /api/v1/products/facets', () => {
  it('devuelve categorías con su número de productos', async () => {
    const res = await request(app).get(`${api}/facets`);

    expect(res.status).toBe(200);

    const { categories } = res.body.data;
    expect(categories.length).toBeGreaterThan(0);

    for (const category of categories) {
      expect(category).toMatchObject({
        name: expect.any(String),
        slug: expect.any(String),
        count: expect.any(Number)
      });
      expect(category.count).toBeGreaterThan(0);
    }

    // "facets" no debe colarse en /:key y devolver un 404 de producto.
    const total = await prisma.product.count({ where: { status: 'ACTIVE' } });
    const summed = categories.reduce((total, category) => total + category.count, 0);
    expect(summed).toBe(total);
  });

  it('separa tallas y colores y cuenta PRODUCTOS, no variantes', async () => {
    const res = await request(app).get(`${api}/facets`);
    const { sizes, colors } = res.body.data;

    expect(sizes.length).toBeGreaterThan(0);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.some((color) => /^#[0-9A-Fa-f]{6}$/.test(color.hexColor ?? ''))).toBe(true);

    // "Remera Lino Test" tiene dos variantes sin talla asignada: la faceta
    // cuenta productos distintos, nunca variantes.
    for (const size of sizes) {
      const variants = await prisma.productVariant.findMany({
        where: { isActive: true, product: { status: 'ACTIVE' }, sizeValueId: size.id },
        select: { productId: true }
      });
      const distinct = new Set(variants.map((variant) => variant.productId)).size;

      expect(size.count).toBe(distinct);
    }

    // Un filtro por una talla sin productos no debe aparecer en la lista.
    const usedIds = new Set(
      (
        await prisma.productVariant.findMany({
          where: { isActive: true, product: { status: 'ACTIVE' } },
          select: { sizeValueId: true }
        })
      ).map((variant) => variant.sizeValueId)
    );
    expect(sizes.every((size) => usedIds.has(size.id))).toBe(true);
  });

  it('no filtra por DRAFT ni por ARCHIVED', async () => {
    const res = await request(app).get(`${api}/facets`);
    const { categories } = res.body.data;

    for (const category of categories) {
      const real = await prisma.product.count({ where: { categoryId: category.id, status: 'ACTIVE' } });
      expect(category.count).toBe(real);
    }
  });
});

describe('GET /api/v1/products/:key', () => {
  it('devuelve el detalle por slug con variantes y relacionados', async () => {
    const created = await createProduct({ name: 'Falda Midi Test', variants: [{ stock: 2 }] });
    const res = await request(app).get(`${api}/${created.slug}`);

    expect(res.status).toBe(200);
    const { product, related } = res.body.data;

    expect(product.slug).toBe(created.slug);
    expect(product.slug).toBe(slugify(created.name));
    expect(product.variants.length).toBeGreaterThan(0);
    expect(Array.isArray(related)).toBe(true);
  });

  it('expone el precio efectivo con precio tachado si hay oferta', async () => {
    const base = 59.9;
    const sale = discounted(base);
    const created = await createProduct({
      name: 'Blusa Modal Test',
      basePrice: base,
      salePrice: sale,
      variants: [{ stock: 1 }]
    });

    const res = await request(app).get(`${api}/${created.slug}`);
    const { product } = res.body.data;
    const discountedVariant = product.variants.find((variant) => variant.discountPercentage > 0);

    expect(discountedVariant).toBeDefined();
    expect(discountedVariant.compareAtPrice).toBeGreaterThan(discountedVariant.price);
    expect(product.price).toBe(sale);
    expect(product.compareAtPrice).toBe(base);
    expect(product.taxRate).toBe(0.21);
  });

  it('devuelve 404 con mensaje claro si no existe', async () => {
    const res = await request(app).get(`${api}/no-existe-este-producto`);

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.body.message).toContain('no-existe-este-producto');
  });
});
