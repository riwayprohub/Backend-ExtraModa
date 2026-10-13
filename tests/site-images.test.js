import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

const SITE = '/api/v1/site-images';

// 1x1 PNG real: un Buffer cualquiera fallaría en la comprobación de imagen.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

let adminToken;
let customerToken;

async function tokenFor(email, password) {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.accessToken;
}

const withAuth = (method, url, token) =>
  request(app)[method](url).set('Authorization', `Bearer ${token}`);

/** Hueco de prueba FUERA de los que siembra el seed, para no pisarlos. */
const TEST_SLOT = 'category-remeras';

const original = {};

beforeAll(async () => {
  adminToken = await tokenFor('admin@extramoda.es', 'Password123!');
  customerToken = await tokenFor('cliente@ejemplo.com', 'Password123!');

  // Se guarda el estado previo del hueco de prueba para devolverlo al terminar.
  const existing = await prisma.siteImage.findUnique({ where: { slot: TEST_SLOT } });
  if (existing) {
    original.row = await prisma.siteImage.findUnique({ where: { slot: TEST_SLOT } });
  }
});

afterAll(async () => {
  await prisma.siteImage.deleteMany({ where: { slot: TEST_SLOT } });
  if (original.row) {
    await prisma.siteImage.create({ data: original.row });
  }
});

// ── Lectura pública ───────────────────────────────────────────────────────────

describe('GET /api/v1/site-images', () => {
  it('es público y devuelve las fotos del inicio', async () => {
    const res = await request(app).get(SITE);

    expect(res.status).toBe(200);
    const slots = res.body.data.map((image) => image.slot);
    expect(slots).toContain('hero-1');
    expect(slots).toContain('category-jeans');
  });

  it('marca las fotos del seed como no subidas', async () => {
    const res = await request(app).get(SITE);
    const hero = res.body.data.find((image) => image.slot === 'hero-1');

    expect(hero.url).toMatch(/^https?:\/\//); // externa del seed
    expect(hero.uploaded).toBe(false);
  });
});

// ── Subida ────────────────────────────────────────────────────────────────────

describe('POST /api/v1/site-images', () => {
  it('sube la foto, la guarda en MySQL y reemplaza la anterior del hueco', async () => {
    const first = await withAuth('post', SITE, adminToken)
      .field('slot', TEST_SLOT)
      .field('altText', 'Remeras de prueba')
      .attach('image', png, { filename: 'remeras.png', contentType: 'image/png' });

    expect(first.status).toBe(201);
    expect(first.body.data.url).toBe(`${SITE}/${TEST_SLOT}`);
    expect(first.body.data.altText).toBe('Remeras de prueba');

    // Segunda subida al MISMO slot: reemplaza, no acumula.
    const second = await withAuth('post', SITE, adminToken)
      .field('slot', TEST_SLOT)
      .attach('image', png, { filename: 'remeras2.png', contentType: 'image/png' });

    expect(second.status).toBe(201);

    const rows = await prisma.siteImage.findMany({ where: { slot: TEST_SLOT } });
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(Buffer.from(row.data).equals(png)).toBe(true);
    expect(row.mime).toBe('image/png');
    expect(row.bytes).toBe(png.length);
  });

  it('sirve el binario desde GET /:slot', async () => {
    await withAuth('post', SITE, adminToken)
      .field('slot', TEST_SLOT)
      .attach('image', png, { filename: 'remeras.png', contentType: 'image/png' });

    const res = await request(app).get(`${SITE}/${TEST_SLOT}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/png');
    expect(Buffer.from(res.body).equals(png)).toBe(true);
  });

  it('rechaza un slot que no es un hueco de la portada con 422', async () => {
    const res = await withAuth('post', SITE, adminToken)
      .field('slot', 'hueco-inventado')
      .attach('image', png, { filename: 'x.png', contentType: 'image/png' });

    expect(res.status).toBe(422);
  });

  it('rechaza un tipo no permitido con 400', async () => {
    const res = await withAuth('post', SITE, adminToken)
      .field('slot', TEST_SLOT)
      .attach('image', Buffer.from('#!/bin/sh\necho hack'), {
        filename: 'script.svg',
        contentType: 'image/svg+xml'
      });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/formato no permitido/i);
  });

  it('exige autenticación y rechaza a un CUSTOMER con 403', async () => {
    const anon = await request(app).post(SITE).field('slot', TEST_SLOT).attach('image', png, {
      filename: 'x.png',
      contentType: 'image/png'
    });
    expect(anon.status).toBe(401);

    const customer = await withAuth('post', SITE, customerToken)
      .field('slot', TEST_SLOT)
      .attach('image', png, { filename: 'x.png', contentType: 'image/png' });
    expect(customer.status).toBe(403);
  });
});

// ── Borrado ───────────────────────────────────────────────────────────────────

describe('DELETE /api/v1/site-images/:slot', () => {
  it('quita la imagen y el hueco vuelve a estar vacío', async () => {
    await withAuth('post', SITE, adminToken)
      .field('slot', TEST_SLOT)
      .attach('image', png, { filename: 'remeras.png', contentType: 'image/png' });

    const res = await withAuth('delete', `${SITE}/${TEST_SLOT}`, adminToken);

    expect(res.status).toBe(200);
    const row = await prisma.siteImage.findUnique({ where: { slot: TEST_SLOT } });
    expect(row).toBeNull();

    // El listado público ya no lo incluye.
    const list = await request(app).get(SITE);
    expect(list.body.data.map((image) => image.slot)).not.toContain(TEST_SLOT);
  });

  it('devuelve 404 si el hueco ya estaba vacío', async () => {
    const res = await withAuth('delete', `${SITE}/${TEST_SLOT}`, adminToken);
    expect(res.status).toBe(404);
  });

  it('rechaza a un CUSTOMER con 403', async () => {
    const res = await withAuth('delete', `${SITE}/${TEST_SLOT}`, customerToken);
    expect(res.status).toBe(403);
  });
});

// ── Endpoint de servicio del binario ──────────────────────────────────────────

describe('GET /api/v1/site-images/:slot', () => {
  it('redirige a la foto externa cuando el hueco es del seed', async () => {
    const res = await request(app).get(`${SITE}/hero-2`).redirects(0);

    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^https?:\/\//);
  });

  it('devuelve 404 con un hueco inválido o inexistente', async () => {
    const invalid = await request(app).get(`${SITE}/no-es-un-slot`);
    expect(invalid.status).toBe(422);

    // 'shorts' es un hueco válido que el seed no siembra: no tiene imagen.
    const empty = await request(app).get(`${SITE}/category-shorts`);
    expect(empty.status).toBe(404);
  });
});
