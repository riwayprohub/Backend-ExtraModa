import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import app from '../src/app.js';
import { prisma } from '../src/config/database.js';

/**
 * Test de integración real: hace peticiones HTTP contra la app Express
 * (sin listen, sin abrir un puerto) y consulta MySQL de verdad.
 */
describe('GET /api/v1/health', () => {
  it('responde 200 con la base de datos conectada', async () => {
    const res = await request(app).get('/api/v1/health');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.status).toBe('ok');
    expect(res.body.data.database.status).toBe('up');
  });
});

describe('GET /api/v1 (raíz)', () => {
  it('expone la información del servicio', async () => {
    const res = await request(app).get('/api/v1');

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Extramoda API');
  });
});

describe('404 y errores', () => {
  it('devuelve 404 estructurado para rutas inexistentes', async () => {
    const res = await request(app).get('/api/v1/no-existe');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('devuelve 400 con JSON malformado', async () => {
    const res = await request(app)
      .post('/api/v1/health')
      .set('Content-Type', 'application/json')
      .send('{ esto no es json');

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_JSON');
  });
});

describe('Datos sembrados', () => {
  // La tienda arranca SIN productos: el catálogo se crea desde el panel. Lo
  // que el seed garantiza es el armazón: categorías, usuarios, cupones y las
  // fotos del escaparate de inicio.
  it('deja las 10 categorías fijas de la tienda', async () => {
    const categories = await prisma.category.findMany({ orderBy: { position: 'asc' } });

    expect(categories.map((category) => category.name)).toEqual([
      'Accesorios',
      'Abrigos',
      'Blusas',
      'Calzados',
      'Faldas',
      'Jeans',
      'Remeras',
      'Shorts',
      'Sweater',
      'Vestidos'
    ]);
  });

  it('deja usuarios, cupones y fotos de inicio', async () => {
    const [admin, coupons, images] = await Promise.all([
      prisma.user.findUnique({ where: { email: 'admin@extramoda.es' } }),
      prisma.coupon.count(),
      prisma.siteImage.count()
    ]);

    expect(admin?.role).toBe('ADMIN');
    expect(coupons).toBe(2);
    expect(images).toBeGreaterThanOrEqual(8); // 2 del hero + 6 de categoría
  });

  it('arranca sin productos: el catálogo se crea desde el panel', async () => {
    expect(await prisma.product.count()).toBe(0);
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});