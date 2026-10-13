import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import app from '../src/app.js';
import { createLoginLimiter } from '../src/modules/auth/auth.routes.js';
import { prisma } from '../src/config/database.js';

const register = (body) => request(app).post('/api/v1/auth/register').send(body);
const login = (body) => request(app).post('/api/v1/auth/login').send(body);

// Email único por test: los tests comparten base de datos real.
let counter = 0;
const uniqueEmail = (prefix = 'test') => `${prefix}.${Date.now()}.${counter++}@ejemplo.com`;
const validPassword = 'Password123';

// Todos los correos que registra la suite, para borrarlos al terminar. Los
// tests corren contra el MySQL de desarrollo: sin esta lista, cada `npm test`
// dejaba usuarios de tirón en la base y a la semana eran cientos.
const createdEmails = new Set();

async function registerUser(overrides = {}) {
  const body = {
    firstName: 'Marta',
    lastName: 'Ruiz',
    email: uniqueEmail(),
    password: validPassword,
    ...overrides
  };
  createdEmails.add(body.email);
  const res = await register(body);
  return { body, res };
}

describe('POST /api/v1/auth/register', () => {
  it('crea la cuenta, devuelve access token y cookie de refresh', async () => {
    const { body, res } = await registerUser();

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(body.email);
    expect(res.body.data.user.role).toBe('CUSTOMER');
    expect(res.body.data.accessToken).toBeTruthy();

    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    expect(cookies.join(';')).toContain('extramoda_rt=');
    expect(cookies.join(';')).toContain('HttpOnly');
  });

  it('nunca devuelve el hash de la contraseña', async () => {
    const { res } = await registerUser();
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    expect(JSON.stringify(res.body)).not.toContain(validPassword);
  });

  it('guarda el hash con bcrypt, no en texto plano', async () => {
    const { body } = await registerUser();
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    expect(user.passwordHash).not.toBe(validPassword);
    expect(user.passwordHash.startsWith('$2')).toBe(true);
  });

  it('rechaza emails duplicados con 409', async () => {
    const email = uniqueEmail('dup');
    await registerUser({ email });
    const { res } = await registerUser({ email });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
    expect(res.body.errors).toHaveProperty('email');
  });

  it('rechaza contraseñas débiles con 422 y mensaje en español', async () => {
    const { res } = await registerUser({ password: 'corta' });

    expect(res.status).toBe(422);
    expect(res.body.errors.password).toMatch(/8 caracteres/);
  });

  it('ignora en silencio un intento de auto-asignarse el rol ADMIN', async () => {
    const { body, res } = await registerUser({ role: 'ADMIN' });
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // El campo no está en el schema Zod: se descarta, no se rechaza con 422
    expect(res.status).toBe(201);
    expect(user).not.toBeNull();
    expect(user.role).toBe('CUSTOMER');
  });
});

describe('POST /api/v1/auth/login', () => {
  it('inicia sesión con credenciales correctas', async () => {
    const { body } = await registerUser();
    const res = await login({ email: body.email, password: validPassword });

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toBeTruthy();
    expect(res.headers['set-cookie'].join(';')).toContain('extramoda_rt=');
  });

  it('devuelve el mismo mensaje con contraseña incorrecta y con email inexistente', async () => {
    const { body } = await registerUser();

    const wrongPassword = await login({ email: body.email, password: 'OtraClave123' });

    const unknownEmail = await login({ email: uniqueEmail('fantasma'), password: validPassword });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Sin esta igualdad, el endpoint permite enumerar cuentas registradas.
    expect(wrongPassword.body.message).toBe(unknownEmail.body.message);
  });

  it('bloquea con 429 tras superar los intentos permitidos para esa cuenta', async () => {
    // App aislada con el rate limiter real: los limiters están desactivados en la
    // app de test (comparten IP), así que aquí se instancia uno con skipInTest: false.
    const limited = express();
    limited.use(express.json());
    limited.post('/login', createLoginLimiter({ limit: 3, skipInTest: false }), (req, res) =>
      res.json({ ok: true })
    );
    const limitedApp = request(limited);

    const email = uniqueEmail('fuerza-bruta');

    const statuses = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const res = await limitedApp.post('/login').send({ email, password: `intento-${attempt}` });
      statuses.push(res.status);
    }

    expect(statuses).toEqual([200, 200, 200, 429, 429]);

    // La clave es IP+email: otra cuenta desde la misma IP no se ve afectada
    const otro = await limitedApp.post('/login').send({ email: uniqueEmail('otra'), password: validPassword });
    expect(otro.status).toBe(200);
  });
});

describe('Sesiones y refresh', () => {
  it('GET /me exige un access token válido', async () => {
    const { body, res } = await registerUser();

    const sinToken = await request(app).get('/api/v1/auth/me');
    const tokenInvalido = await request(app).get('/api/v1/auth/me').set('Authorization', 'Bearer no-es-un-jwt');

    expect(sinToken.status).toBe(401);
    expect(tokenInvalido.status).toBe(401);

    const res2 = await request(app)
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);

    expect(res2.status).toBe(200);
    expect(res2.body.data.user.email).toBe(body.email);
  });

  it('renueva el access token y rota la cookie de refresh', async () => {
    const { body, res } = await registerUser();
    const agent = request.agent(app);

    const login = await agent.post('/api/v1/auth/login').send({ email: body.email, password: validPassword });
    const refreshAntigua = cookieDe(login);

    const refresh = await agent.post('/api/v1/auth/refresh').send({});
    const refreshNueva = cookieDe(refresh);

    expect(refresh.status).toBe(200);
    expect(refresh.body.data.accessToken).toBeTruthy();
    expect(refreshNueva).not.toBe(refreshAntigua); // el token anterior queda inutilizable
  });

  it('detecta reutilización del refresh token y cierra todas las sesiones', async () => {
    const { body } = await registerUser();

    // Cookies manipuladas a mano: el agente de supertest no refleja el par de
    // Set-Cookie de forma fiable en este escenario.
    const loginRes = await login({ email: body.email, password: validPassword });
    const tokenAntiguo = cookieDe(loginRes);

    const primerRefresh = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `extramoda_rt=${tokenAntiguo}`)
      .send({});

    expect(primerRefresh.status).toBe(200);
    const tokenNuevo = cookieDe(primerRefresh);
    expect(tokenNuevo).not.toBe(tokenAntiguo);

    // Un atacante reutiliza el token ANTIGUO (el que la víctima ya rotó)
    const reutilizado = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `extramoda_rt=${tokenAntiguo}`)
      .send({});

    expect(reutilizado.status).toBe(401);
    expect(reutilizado.body.errors.code).toBe('TOKEN_REUSE_DETECTED');

    // Cierre de emergencia: el token nuevo tampoco sirve
    const posterior = await request(app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', `extramoda_rt=${tokenNuevo}`)
      .send({});

    expect(posterior.status).toBe(401);
  });

  it('elimina el refresh token de la base de datos (solo se guarda su hash)', async () => {
    const { body, res } = await registerUser();
    const tokenCrudo = cookieDe(res);

    const sesiones = await prisma.session.findMany({ where: { user: { email: body.email } } });
    expect(sesiones).toHaveLength(1);
    expect(sesiones[0].refreshTokenHash).not.toBe(tokenCrudo);
    expect(sesiones[0].refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('logout revoca la sesión y borra la cookie', async () => {
    const { body } = await registerUser();
    const agent = request.agent(app);
    await agent.post('/api/v1/auth/login').send({ email: body.email, password: validPassword });

    const logout = await agent.post('/api/v1/auth/logout').send({});
    expect(logout.status).toBe(200);

    const refresh = await agent.post('/api/v1/auth/refresh').send({});
    expect(refresh.status).toBe(401);
  });
});

describe('Autorización por rol', () => {
  it('un CUSTOMER no puede listar usuarios', async () => {
    const { body } = await registerUser();
    const userLogin = await login({ email: body.email, password: validPassword });

    const res = await request(app)
      .get('/api/v1/auth/admin/users')
      .set('Authorization', `Bearer ${userLogin.body.data.accessToken}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('un ADMIN sí puede', async () => {
    const adminLogin = await login({ email: 'admin@extramoda.es', password: 'Password123!' });

    expect(adminLogin.status).toBe(200);

    const res = await request(app)
      .get('/api/v1/auth/admin/users')
      .query({ perPage: 5 })
      .set('Authorization', `Bearer ${adminLogin.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.meta.total).toBeGreaterThan(0);
  });
});

describe('Perfil y sesiones', () => {
  it('actualiza el perfil con campos validados', async () => {
    const { res } = await registerUser();
    const me = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .send({ firstName: 'Marta', lastName: 'Sánchez', phone: '+34600111222' });

    expect(me.status).toBe(200);
    expect(me.body.data.user.fullName).toBe('Marta Sánchez');
  });

  it('rechaza un cuerpo vacío al actualizar el perfil', async () => {
    const { res } = await registerUser();
    const me = await request(app)
      .patch('/api/v1/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .send({});

    expect(me.status).toBe(422);
  });

  it('lista las sesiones activas marcando la actual', async () => {
    const { body } = await registerUser();
    const agent = request.agent(app);
    const login = await agent.post('/api/v1/auth/login').send({ email: body.email, password: validPassword });

    const res = await agent
      .get('/api/v1/auth/sessions')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.sessions.length).toBeGreaterThanOrEqual(2);
    expect(res.body.data.sessions.filter((s) => s.isCurrent)).toHaveLength(1);
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function cookieDe(res) {
  const cookie = res.headers['set-cookie']?.find((c) => c.startsWith('extramoda_rt='));
  return cookie?.split(';')[0].replace('extramoda_rt=', '');
}

afterAll(async () => {
  await prisma.user.deleteMany({ where: { email: { in: [...createdEmails] } } });
  await prisma.$disconnect();
});