import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

const CATEGORIES = '/api/v1/categories';

// Igual que la suite de productos: la purga va por prefijo y no por ids, para
// que un test que revienta a medias no deje filas permanentes en la BD.
const TEST_NAME_PREFIX = 'ZZTest ';
const created = []; // ids de las categorías creadas por los tests
let createdProductId = null;

let adminToken;
let customerToken;

async function tokenFor(email, password) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken;
}

const withAuth = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

const newCategory = (overrides = {}) => ({
  name: `${TEST_NAME_PREFIX}${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
  ...overrides
});

/** Borra primero los productos de prueba (la categoría no se borra con productos). */
async function purgeTestData() {
  await prisma.product.deleteMany({ where: { name: { startsWith: TEST_NAME_PREFIX } } });
  await prisma.category.deleteMany({ where: { name: { startsWith: TEST_NAME_PREFIX } } });
}

beforeAll(async () => {
  await purgeTestData();
  adminToken = await tokenFor('admin@extramoda.es', 'Password123!');
  customerToken = await tokenFor('cliente@ejemplo.com', 'Password123!');
});

afterAll(async () => {
  if (createdProductId) await prisma.product.deleteMany({ where: { id: createdProductId } });
  await purgeTestData();
});

// ── Control de acceso ────────────────────────────────────────────────────────

describe('Categorías: control de acceso', () => {
  it('la lectura pública no pide token', async () => {
    const res = await request(app).get(CATEGORIES);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  it('rechaza crear sin token con 401', async () => {
    const res = await request(app).post(CATEGORIES).send(newCategory());
    expect(res.status).toBe(401);
  });

  it('rechaza crear a un CUSTOMER con 403', async () => {
    const res = await withAuth('post', CATEGORIES, customerToken).send(newCategory());
    expect(res.status).toBe(403);
  });

  it('rechaza /all a un CUSTOMER con 403', async () => {
    const res = await withAuth('get', `${CATEGORIES}/all`, customerToken);
    expect(res.status).toBe(403);
  });
});

// ── Alta ─────────────────────────────────────────────────────────────────────

describe('POST /api/v1/categories', () => {
  it('crea la categoría con slug generado del nombre', async () => {
    const res = await withAuth('post', CATEGORIES, adminToken).send(
      newCategory({ name: 'ZZTest Pantalones Corte' })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe('zztest-pantalones-corte');
    expect(res.body.data.isActive).toBe(true);
    expect(res.body.data.productCount).toBe(0);
    created.push(res.body.data.id);
  });

  it('acepta slug explícito y posición', async () => {
    const slug = `zztest-slug-${Date.now()}`;
    const res = await withAuth('post', CATEGORIES, adminToken).send(
      newCategory({ slug, position: 7 })
    );

    expect(res.status).toBe(201);
    expect(res.body.data.slug).toBe(slug);
    expect(res.body.data.position).toBe(7);
    created.push(res.body.data.id);
  });

  it('rechaza un nombre demasiado corto con 422', async () => {
    const res = await withAuth('post', CATEGORIES, adminToken).send(newCategory({ name: 'A' }));
    expect(res.status).toBe(422);
  });

  it('rechaza un slug con caracteres inválidos con 422', async () => {
    const res = await withAuth('post', CATEGORIES, adminToken).send(
      newCategory({ slug: 'Slug Con Espacios' })
    );
    expect(res.status).toBe(422);
  });
});

// ── Listados ─────────────────────────────────────────────────────────────────

describe('Listados de categorías', () => {
  it('el panel ve las desactivadas y la tienda no', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({ isActive: false });

    const publicList = await request(app).get(CATEGORIES);
    expect(publicList.body.data.map((c) => c.id)).not.toContain(created_.body.data.id);

    const adminList = await withAuth('get', `${CATEGORIES}/all`, adminToken);
    expect(adminList.status).toBe(200);
    expect(adminList.body.data.map((c) => c.id)).toContain(created_.body.data.id);
  });
});

// ── Modificación ─────────────────────────────────────────────────────────────

describe('PATCH /api/v1/categories/:id', () => {
  it('actualiza nombre y descripción', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({
      name: 'ZZTest Renombrada',
      description: 'Descripción de prueba'
    });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('ZZTest Renombrada');
    expect(res.body.data.description).toBe('Descripción de prueba');
  });

  it('desactiva y reactiva la categoría', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    const off = await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({ isActive: false });
    expect(off.body.data.isActive).toBe(false);

    const on = await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({ isActive: true });
    expect(on.body.data.isActive).toBe(true);
  });

  it('cuelga una subcategoría de su padre y la devuelve a raíz con null', async () => {
    const parent = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    const child = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(parent.body.data.id, child.body.data.id);

    const attached = await withAuth('patch', `${CATEGORIES}/${child.body.data.id}`, adminToken).send({
      parentId: parent.body.data.id
    });
    expect(attached.status).toBe(200);
    expect(attached.body.data.parentId).toBe(parent.body.data.id);
    expect(attached.body.data.parentName).toBe(parent.body.data.name);

    const detached = await withAuth('patch', `${CATEGORIES}/${child.body.data.id}`, adminToken).send({
      parentId: null
    });
    expect(detached.body.data.parentId).toBeNull();
  });

  it('impide que una categoría sea padre de sí misma con 400', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({
      parentId: created_.body.data.id
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sí misma/i);
  });

  it('impide colgar una categoría bajo su propia hija con 400', async () => {
    const parent = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    const child = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(parent.body.data.id, child.body.data.id);

    await withAuth('patch', `${CATEGORIES}/${child.body.data.id}`, adminToken).send({
      parentId: parent.body.data.id
    });

    const res = await withAuth('patch', `${CATEGORIES}/${parent.body.data.id}`, adminToken).send({
      parentId: child.body.data.id
    });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/subcategor/i);
  });

  it('rechaza un body vacío con 422', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    const res = await withAuth('patch', `${CATEGORIES}/${created_.body.data.id}`, adminToken).send({});
    expect(res.status).toBe(422);
  });

  it('rechaza un id con formato inválido con 422', async () => {
    const res = await withAuth('patch', `${CATEGORIES}/no-existe-este-id`, adminToken).send({ name: 'X' });
    // El schema de parámetro exige un cuid: falla antes de tocar la BD.
    expect(res.status).toBe(422);
  });

  it('devuelve 404 con un id válido que no existe', async () => {
    // El body tiene que ser válido para llegar al service: si no, el 422 de
    // la validación del cuerpo taparía el 404 que queremos comprobar.
    const res = await withAuth('patch', `${CATEGORIES}/clxxxxxxxxxxxxxxxxxx`, adminToken).send({
      name: 'Categoría Que No Existe'
    });
    expect(res.status).toBe(404);
  });
});

// ── Reordenación ─────────────────────────────────────────────────────────────

describe('PATCH /api/v1/categories/order', () => {
  it('aplica el índice recibido como posición', async () => {
    const a = await withAuth('post', CATEGORIES, adminToken).send(newCategory({ position: 0 }));
    const b = await withAuth('post', CATEGORIES, adminToken).send(newCategory({ position: 1 }));
    created.push(a.body.data.id, b.body.data.id);

    const res = await withAuth('patch', `${CATEGORIES}/order`, adminToken).send({
      ids: [b.body.data.id, a.body.data.id]
    });

    expect(res.status).toBe(200);
    const list = await withAuth('get', `${CATEGORIES}/all`, adminToken);
    const byId = new Map(list.body.data.map((c) => [c.id, c.position]));
    expect(byId.get(b.body.data.id)).toBe(0);
    expect(byId.get(a.body.data.id)).toBe(1);
  });

  it('rechaza ids inexistentes con 400', async () => {
    const res = await withAuth('patch', `${CATEGORIES}/order`, adminToken).send({
      ids: ['clxxxxxxxxxxxxxxxxxx']
    });
    expect(res.status).toBe(400);
  });
});

// ── Baja ─────────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/categories/:id', () => {
  it('borra una categoría vacía', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    const res = await withAuth('delete', `${CATEGORIES}/${created_.body.data.id}`, adminToken);

    expect(res.status).toBe(200);
    const row = await prisma.category.findUnique({ where: { id: created_.body.data.id } });
    expect(row).toBeNull();
  });

  it('no borra una categoría con productos asignados', async () => {
    const created_ = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(created_.body.data.id);

    // Producto mínimo para ocupar la categoría.
    const product = await withAuth('post', '/api/v1/products', adminToken).send({
      name: `${TEST_NAME_PREFIX}Producto Ocupa Cat`,
      sku: `ZZT-CAT-${Date.now()}`,
      description: 'Producto de prueba para ocupar una categoría.',
      basePrice: 10,
      categoryId: created_.body.data.id
    });
    createdProductId = product.body.data.id;

    const res = await withAuth('delete', `${CATEGORIES}/${created_.body.data.id}`, adminToken);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/producto/i);
  });

  it('no borra una categoría con subcategorías', async () => {
    const parent = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    const child = await withAuth('post', CATEGORIES, adminToken).send(newCategory());
    created.push(parent.body.data.id, child.body.data.id);

    await withAuth('patch', `${CATEGORIES}/${child.body.data.id}`, adminToken).send({
      parentId: parent.body.data.id
    });

    const res = await withAuth('delete', `${CATEGORIES}/${parent.body.data.id}`, adminToken);

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/subcategor/i);
  });

  it('rechaza el borrado a un CUSTOMER con 403', async () => {
    const res = await withAuth('delete', `${CATEGORIES}/clxxxxxxxxxxxxxxxxxx`, customerToken);
    expect(res.status).toBe(403);
  });
});
