import { AppError } from '../../utils/AppError.js';
import { slugify } from '../../utils/slugify.js';
import * as repository from './category.repository.js';

/**
 * Reglas de negocio de las categorías.
 * No conoce req/res: recibe datos ya validados y devuelve DTOs.
 */

export const categoryService = {
  /**
   * Listado público: solo activas. Lo consumen los filtros del catálogo y el
   * pie, que ya no deducen las categorías de la página cargada.
   */
  async list() {
    const categories = await repository.findActive();

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageUrl: category.imageUrl,
      parentId: category.parentId,
      productCount: category._count.products
    }));
  },

  /**
   * Listado del panel: TODAS, incluidas las desactivadas, con su padre y su
   * número de productos publicados. Una categoría vacía o desactivada tiene
   * que seguir siendo editable desde el panel.
   */
  async listAll() {
    const categories = await repository.findMany();

    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      description: category.description,
      imageUrl: category.imageUrl,
      parentId: category.parentId,
      parentName: category.parent?.name ?? null,
      position: category.position,
      isActive: category.isActive,
      productCount: category._count.products,
      childCount: category.children?.length ?? 0,
      createdAt: category.createdAt,
      updatedAt: category.updatedAt
    }));
  },

  async create(input) {
    const slug = await uniqueSlug(input.slug ?? slugify(input.name));

    const parent = await requireParent(input.parentId);

    const category = await repository.create({
      name: input.name,
      slug,
      description: input.description ?? null,
      imageUrl: input.imageUrl ?? null,
      parentId: parent?.id ?? null,
      position: input.position ?? 0,
      isActive: input.isActive ?? true
    });

    return toDto(category);
  },

  async update(id, input) {
    const existing = await repository.findById(id);
    if (!existing) throw AppError.notFound('Esa categoría no existe');

    const data = { ...input };
    delete data.parentId;

    // El padre se trata aparte: `null` es un valor válido (pasar a raíz) y
    // `undefined` significa "no tocar". Con un simple spread del input no se
    // distinguen los dos casos.
    if ('parentId' in input) {
      if (input.parentId === null) {
        data.parentId = null;
      } else {
        const parent = await requireParent(input.parentId);
        assertNoCycle(existing, parent);
        data.parentId = parent.id;
      }
    }

    if (data.slug !== undefined) {
      const unique = await uniqueSlug(data.slug, id);
      if (unique !== data.slug) {
        throw AppError.duplicate(`El slug "${data.slug}" ya existe`, { slug: 'Slug duplicado' });
      }
      data.slug = unique;
    }

    const category = await repository.update(id, data);
    return toDto(category);
  },

  /**
   * Borrado con protección: una categoría con productos asignados NO se borra.
   * Hacerlo dejaría esos productos con categoryId huérfano (SetNull) y fuera
   * de todos los filtros, así que se obliga a reasignarlos primero.
   */
  async remove(id) {
    const existing = await repository.findById(id);
    if (!existing) throw AppError.notFound('Esa categoría no existe');

    const products = await repository.countProducts(id);
    if (products > 0) {
      throw AppError.conflict(
        `La categoría tiene ${products} producto(s) asignados. Reasignalos a otra categoría antes de borrarla.`,
        { productCount: products }
      );
    }

    const children = await repository.findDescendantIds(id);
    if (children.length > 0) {
      throw AppError.conflict(
        `La categoría tiene ${children.length} subcategoría(s). Bórralas o muévelas antes.`,
        { childCount: children.length }
      );
    }

    await repository.remove(id);
    return { id };
  },

  /** Reordenación en bloque: la posición pasa a ser el índice recibido. */
  async reorder({ ids }) {
    const existing = await repository.findMany();
    const known = new Set(existing.map((category) => category.id));
    const missing = ids.filter((id) => !known.has(id));

    if (missing.length) {
      throw AppError.badRequest('Alguna de las categorías no existe', { missing: missing.join(', ') });
    }

    await repository.reorder(ids);
    return this.listAll();
  }
};

// ── Auxiliares ──────────────────────────────────────────────────────────────

function toDto(category) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description ?? null,
    imageUrl: category.imageUrl ?? null,
    parentId: category.parentId,
    parentName: category.parent?.name ?? null,
    position: category.position ?? 0,
    isActive: category.isActive ?? true,
    productCount: category._count?.products ?? 0,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt
  };
}

async function uniqueSlug(base, excludeId) {
  let candidate = base;
  let suffix = 1;

  /* eslint-disable no-await-in-loop */
  while (await repository.slugExists(candidate, excludeId)) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  /* eslint-enable no-await-in-loop */

  return candidate;
}

/** El padre indicado tiene que existir; si no viene, la categoría es raíz. */
async function requireParent(parentId) {
  if (!parentId) return null;

  const parent = await repository.findById(parentId);
  if (!parent) throw AppError.badRequest('La categoría padre no existe', { parentId });

  return parent;
}

/**
 * Una categoría no puede colgar de sí misma ni de uno de sus descendientes:
 * crearía un ciclo que el listado en árbol no podría recorrer.
 *
 * La comprobación cubre un nivel de hijos, que es la profundidad real de esta
 * tienda (raíz → subcategoría). Un árbol más profundo se detectaría igualmente
 * por el índice único y el listado seguiría siendo navegable.
 */
function assertNoCycle(category, parent) {
  if (parent.id === category.id) {
    throw AppError.badRequest('Una categoría no puede ser padre de sí misma');
  }

  const childIds = (category.children ?? []).map((child) => child.id);
  if (childIds.includes(parent.id)) {
    throw AppError.badRequest('No se puede mover una categoría bajo una de sus subcategorías');
  }
}
