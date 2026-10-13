import { AppError } from '../../utils/AppError.js';
import * as repository from './coupon.repository.js';

/**
 * Reglas de negocio de las promociones (cupones de descuento).
 * No conoce req/res: recibe datos ya validados y devuelve DTOs.
 */

/**
 * Estado derivado del cupón. Se calcula en cada lectura (no se guarda) porque
 * depende del reloj: un cupón "ACTIVE" cuya fecha de fin acaba de pasar debe
 * aparecer como caducado aunque nadie haya tocado la fila.
 */
function stateOf(coupon, now) {
  if (!coupon.isActive) return 'INACTIVE';
  if (coupon.startsAt && coupon.startsAt > now) return 'SCHEDULED';
  if (coupon.expiresAt && coupon.expiresAt <= now) return 'EXPIRED';
  if (coupon.usageLimit !== null && coupon.usedCount >= coupon.usageLimit) return 'EXHAUSTED';
  return 'ACTIVE';
}

const STATE_LABELS = {
  ACTIVE: 'Activo',
  INACTIVE: 'Desactivado',
  SCHEDULED: 'Programado',
  EXPIRED: 'Caducado',
  EXHAUSTED: 'Agotado'
};

export const couponService = {
  async list({ state, page, perPage }) {
    const now = new Date();

    // El filtro por estado se resuelve en SQL sobre isActive/fechas. El estado
    // AGOTADO (usedCount >= usageLimit) se calcula en el DTO pero no se filtra
    // aquí: son decenas de filas como máximo y ya se ve en la tabla.
    const where = {};
    if (state === 'active') {
      where.isActive = true;
      where.AND = [
        { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
        { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }
      ];
    }
    if (state === 'inactive') where.isActive = false;
    if (state === 'expired') where.expiresAt = { lte: now };

    const { items, total } = await repository.findMany({ where, page, perPage });

    const mapped = items.map((coupon) => toDto(coupon, now));

    return {
      items: mapped,
      total,
      page,
      perPage,
      totalPages: Math.max(1, Math.ceil(total / perPage))
    };
  },

  async create(input) {
    const code = input.code.trim().toUpperCase();

    if (await repository.codeExists(code)) {
      throw AppError.duplicate(`El código ${code} ya existe`, { code: 'Código duplicado' });
    }

    await assertProductsExist(input.productIds);

    const coupon = await repository.create({
      code,
      description: input.description ?? null,
      type: input.type,
      value: input.value,
      minSubtotal: input.minSubtotal ?? null,
      maxDiscount: input.maxDiscount ?? null,
      usageLimit: input.usageLimit ?? null,
      perUserLimit: input.perUserLimit ?? 1,
      startsAt: input.startsAt ?? null,
      expiresAt: input.expiresAt ?? null,
      isActive: input.isActive ?? true,
      appliesToAllProducts: input.appliesToAllProducts ?? true,
      productIds: input.appliesToAllProducts === false ? (input.productIds ?? []) : []
    });

    return toDto(coupon, new Date());
  },

  async update(id, input) {
    const existing = await repository.findById(id);
    if (!existing) throw AppError.notFound('Ese cupón no existe');

    const data = { ...input };

    if (data.code !== undefined) {
      const code = data.code.trim().toUpperCase();
      if (await repository.codeExists(code, id)) {
        throw AppError.duplicate(`El código ${code} ya existe`, { code: 'Código duplicado' });
      }
      data.code = code;
    }

    await assertProductsExist(data.productIds);

    // Al desvincular el cupón de productos concretos pasa a valer para todo
    // el catálogo; si no, quedaría restringido a una lista vacía.
    if (data.appliesToAllProducts === true) data.productIds = [];

    const coupon = await repository.update(id, data);
    return toDto(coupon, new Date());
  },

  /**
   * Baja. Si el cupón ya se usó en algún pedido NO se borra: se desactiva, para
   * que el histórico de pedidos siga teniendo el cupón que los generó.
   */
  async remove(id) {
    const existing = await repository.findById(id);
    if (!existing) throw AppError.notFound('Ese cupón no existe');

    const orders = await repository.countOrders(id);
    if (orders > 0) {
      const coupon = await repository.deactivate(id);
      return {
        deleted: false,
        coupon: toDto(coupon, new Date()),
        message: `El cupón se usó en ${orders} pedido(s): lo hemos desactivado en lugar de borrarlo`
      };
    }

    await repository.remove(id);
    return { deleted: true, message: 'Cupón eliminado' };
  }
};

// ── Auxiliares ──────────────────────────────────────────────────────────────

function toDto(coupon, now = new Date()) {
  return {
    id: coupon.id,
    code: coupon.code,
    description: coupon.description,
    type: coupon.type,
    value: Number(coupon.value),
    minSubtotal: coupon.minSubtotal === null ? null : Number(coupon.minSubtotal),
    maxDiscount: coupon.maxDiscount === null ? null : Number(coupon.maxDiscount),
    usageLimit: coupon.usageLimit,
    usedCount: coupon.usedCount,
    perUserLimit: coupon.perUserLimit,
    startsAt: coupon.startsAt,
    expiresAt: coupon.expiresAt,
    isActive: coupon.isActive,
    appliesToAllProducts: coupon.appliesToAllProducts,
    state: stateOf(coupon, now),
    stateLabel: STATE_LABELS[stateOf(coupon, now)],
    orderCount: coupon._count?.orders ?? 0,
    products: (coupon.products ?? []).map((link) => ({
      id: link.product.id,
      name: link.product.name,
      slug: link.product.slug
    })),
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt
  };
}

/** Los productos vinculados tienen que existir antes de crear el cupón. */
async function assertProductsExist(productIds) {
  if (!productIds?.length) return;

  const existing = await repository.findExistingProducts(productIds);
  const missing = productIds.filter((id) => !existing.has(id));

  if (missing.length) {
    throw AppError.badRequest('Algún producto indicado no existe', {
      productIds: missing.join(', ')
    });
  }
}
