import { prisma } from '../../config/database.js';

/**
 * Única capa que habla con la base de datos para categorías.
 * No conoce req/res ni mensajes de error: devuelve datos o lanza.
 */

/**
 * Listado con contador de productos PUBLICADOS.
 *
 * El contador filtrado (`products: { where: ... }`) es la sintaxis de Prisma
 * para un COUNT con condición. Prisma no deja seleccionar la misma relación
 * dos veces con filtros distintos, así que el total bruto (necesario solo para
 * decidir si una categoría se puede borrar) lo pregunta el service aparte:
 * `countProducts`.
 */
export function findMany(where = {}) {
  return prisma.category.findMany({
    where,
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    include: {
      parent: { select: { id: true, name: true, slug: true } },
      _count: { select: { products: { where: { status: 'ACTIVE' } } } }
    }
  });
}

export function findActive() {
  return prisma.category.findMany({
    where: { isActive: true },
    orderBy: [{ position: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      imageUrl: true,
      parentId: true,
      _count: { select: { products: { where: { status: 'ACTIVE' } } } }
    }
  });
}

export function findById(id) {
  return prisma.category.findUnique({
    where: { id },
    include: {
      parent: { select: { id: true, name: true } },
      children: { select: { id: true, name: true }, orderBy: { position: 'asc' } },
      _count: { select: { products: { where: { status: 'ACTIVE' } } } }
    }
  });
}

/** Conteo total de productos: decides si la categoría se puede borrar. */
export function countProducts(id) {
  return prisma.product.count({ where: { categoryId: id } });
}

/** True si el slug está en uso (por otra categoría). */
export function slugExists(slug, excludeId) {
  return prisma.category
    .findFirst({ where: { slug, ...(excludeId && { id: { not: excludeId } }) }, select: { id: true } })
    .then(Boolean);
}

/** Hijos de una categoría, para detectar ciclos al reasignar el padre. */
export function findDescendantIds(rootId) {
  return prisma.category
    .findMany({ where: { parentId: rootId }, select: { id: true } })
    .then((rows) => rows.map((row) => row.id));
}

export function create(data) {
  return prisma.category.create({
    data,
    include: {
      parent: { select: { id: true, name: true } },
      _count: { select: { products: true } }
    }
  });
}

export function update(id, data) {
  return prisma.category.update({
    where: { id },
    data,
    include: {
      parent: { select: { id: true, name: true } },
      children: { select: { id: true, name: true }, orderBy: { position: 'asc' } },
      _count: { select: { products: true } }
    }
  });
}

/**
 * Reordenación en una transacción: o quedan todas en su nuevo sitio, o ninguna.
 * `updateMany` por id porque no existe "update positional" en Prisma.
 */
export function reorder(ids) {
  return prisma.$transaction(
    ids.map((id, index) => prisma.category.updateMany({ where: { id }, data: { position: index } }))
  );
}

export function remove(id) {
  return prisma.category.delete({ where: { id } });
}
