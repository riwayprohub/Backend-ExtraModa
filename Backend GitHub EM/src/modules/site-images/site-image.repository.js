import { prisma } from '../../config/database.js';

/**
 * Única capa que habla con la base de datos para las imágenes del escaparate.
 */

/** Todas las imágenes, en el orden de SITE_IMAGE_SLOTS (los huecos vacíos faltan). */
export function findAll() {
  return prisma.siteImage.findMany({
    orderBy: { slot: 'asc' },
    select: {
      id: true,
      slot: true,
      url: true,
      altText: true,
      mime: true,
      bytes: true,
      updatedAt: true
    }
  });
}

export function findBySlot(slot) {
  return prisma.siteImage.findUnique({
    where: { slot },
    select: { id: true, slot: true, url: true, altText: true, data: true, mime: true, bytes: true }
  });
}

/**
 * Reemplazo atómico del hueco.
 *
 * Se borra y se crea dentro de una transacción: un UPDATE dejaría el binario
 * antiguo en la fila si la nueva foto fallara a mitad, y esta tabla no tiene
 * relación con nada más, así que borrar+crear no rompe ninguna foreign key.
 */
export function replaceSlot({ id, slot, url, altText, data, mime, bytes }) {
  return prisma.$transaction(async (tx) => {
    await tx.siteImage.deleteMany({ where: { slot } });

    return tx.siteImage.create({
      data: { id, slot, url, altText: altText ?? null, data, mime, bytes },
      select: { id: true, slot: true, url: true, altText: true, bytes: true, updatedAt: true }
    });
  });
}

/** Para imágenes externas del seed, sin binario. */
export function upsertExternal({ slot, url, altText }) {
  return prisma.siteImage.upsert({
    where: { slot },
    update: { url, altText: altText ?? null },
    create: { slot, url, altText: altText ?? null },
    select: { id: true, slot: true, url: true }
  });
}

export function remove(slot) {
  return prisma.siteImage.deleteMany({ where: { slot } });
}
