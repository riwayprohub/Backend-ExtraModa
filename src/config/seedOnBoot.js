import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from './database.js';
import { logger } from './logger.js';

/**
 * Rellena la base en el primer arranque.
 *
 * En un despliegue nuevo la tabla de productos está vacía y la tienda se vería
 * sin catálogo ni productos highlighted, así que Render arranca un sitio en
 * blanco. `migrate deploy` crea las tablas pero no mete datos.
 *
 * Se dispara como proceso hijo a propósito:
 *   1. prisma/seed.js se ejecuta solo al importarlo (main() al final), así que
 *      reutilizar su lógica exige lanzarlo como proceso.
 *   2. Aislarlo evita que un fallo del seed tumbe el servidor de la API.
 *
 * Solo corre si NO hay productos. Es idempotente por diseño y evita que un
 * despliegue destructivo borre el catálogo que ha creado el usuario.
 */
export async function seedIfEmpty() {
  const products = await prisma.product.count();
  if (products > 0) {
    logger.info('Catálogo ya presente, se omite el seed', { products });
    return { seeded: false, products };
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const seedFile = path.resolve(here, '../../prisma/seed.js');

  logger.info('Base de datos vacía: ejecutando seed inicial...');

  const code = await new Promise((resolve) => {
    execFile(process.execPath, [seedFile], { cwd: path.resolve(here, '../..') }, (error, stdout, stderr) => {
      if (stdout) process.stdout.write(stdout);
      if (stderr) process.stderr.write(stderr);
      if (error) logger.error('El seed falló', { error: error.message });
      resolve(error ? 1 : 0);
    });
  });

  if (code !== 0) {
    logger.error('Seed inicial fallido: la tienda arrancará sin catálogo');
    return { seeded: false, error: true };
  }

  const after = await prisma.product.count();
  logger.info('Seed inicial completado', { products: after });
  return { seeded: true, products: after };
}