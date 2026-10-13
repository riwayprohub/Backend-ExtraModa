import { z } from 'zod';

/**
 * Validaciones de cupones de descuento.
 *
 * Las reglas replican las que aplica `validateCoupon` (utils/pricing.js) al
 * cobrar: un cupón que pasara por aquí pero fallara al usarlo sería peor que
 * no dejarlo crear, porque el administrador se enteraría por los clientes.
 */

const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'El código debe tener al menos 3 caracteres')
  .max(40)
  .regex(/^[A-Z0-9-]+$/, 'El código solo admite letras mayúsculas, números y guiones');

const description = z.string().trim().max(255);

const discountType = z.enum(['PERCENTAGE', 'FIXED_AMOUNT', 'FREE_SHIPPING']);

/** Valor del descuento. Se valida por tipo en el superRefine de abajo. */
const value = z.coerce
  .number({ error: 'Debe ser un número' })
  .min(0, 'El valor no puede ser negativo')
  .max(100_000, 'Valor demasiado alto');

const positiveInt = (max) => z.coerce.number().int().min(1, 'Como mínimo 1').max(max);

const couponFields = (required = []) => {
  const field = (name, schema) => (required.includes(name) ? schema : schema.optional());
  return {
    code: field('code', code),
    description: field('description', description),
    type: field('type', discountType),
    value: field('value', value),
    minSubtotal: field('minSubtotal', value.nullable()),
    maxDiscount: field('maxDiscount', value.nullable()),
    usageLimit: field('usageLimit', positiveInt(1_000_000).nullable()),
    perUserLimit: field('perUserLimit', positiveInt(100)),
    startsAt: field('startsAt', z.coerce.date().nullable()),
    expiresAt: field('expiresAt', z.coerce.date().nullable()),
    isActive: field('isActive', z.boolean()),
    appliesToAllProducts: field('appliesToAllProducts', z.boolean()),
    productIds: field('productIds', z.array(z.string().cuid()).max(50))
  };
};

/**
 * Reglas cruzadas. El `.nullable()` de arriba permite enviar `null` para
 * LIMPIAR un límite o una fecha, que es distinto de no enviarlo (no tocarlo).
 */
const couponRules = (data, ctx) => {
  if (data.type === 'PERCENTAGE' && data.value !== undefined && data.value > 100) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Un porcentaje no puede superar el 100 %'
    });
  }

  if (data.type === 'FREE_SHIPPING' && data.value !== undefined && data.value !== 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['value'],
      message: 'Un cupón de envío gratuito no lleva valor: déjalo en 0'
    });
  }

  if (data.startsAt != null && data.expiresAt != null && data.startsAt >= data.expiresAt) {
    ctx.addIssue({
      code: 'custom',
      path: ['expiresAt'],
      message: 'La fecha de fin debe ser posterior a la de inicio'
    });
  }

  if (
    data.appliesToAllProducts === false &&
    (!data.productIds || data.productIds.length === 0)
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['productIds'],
      message: 'Indica al menos un producto o marca el cupón para todo el catálogo'
    });
  }
};

export const createCouponSchema = z
  .object({
    ...couponFields(['code', 'type', 'value'])
  })
  .superRefine(couponRules);

export const updateCouponSchema = z
  .object(couponFields())
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Envía al menos un campo para actualizar' });
    }
    couponRules(data, ctx);
  });

export const couponIdParamSchema = z.object({
  id: z.string().cuid('Identificador de cupón inválido')
});

export const listCouponsQuerySchema = z.object({
  /** Filtro del panel: activos, caducados o todos. */
  state: z.enum(['all', 'active', 'inactive', 'expired']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(50)
});
