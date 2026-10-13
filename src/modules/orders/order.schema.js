import { z } from 'zod';

export const addressSchema = z.object({
  firstName: z.string().trim().min(1, 'El nombre es obligatorio').max(80),
  lastName: z.string().trim().min(1, 'Los apellidos son obligatorios').max(80),
  company: z.string().trim().max(120).optional(),
  line1: z.string().trim().min(3, 'La dirección es obligatoria').max(160),
  line2: z.string().trim().max(160).optional(),
  city: z.string().trim().min(1, 'La ciudad es obligatoria').max(80),
  province: z.string().trim().min(1, 'La provincia es obligatoria').max(80),
  postalCode: z
    .string()
    .trim()
    .min(5, 'El código postal debe tener 5 dígitos')
    .max(16)
    .regex(/^[A-Za-z0-9 -]{5,10}$/, 'Código postal inválido'),
  countryCode: z
    .string()
    .trim()
    .toUpperCase()
    .length(2, 'El país se indica con 2 letras (ES)')
    .default('ES'),
  phone: z.string().trim().max(30).optional()
});

/**
 * O una dirección guardada del usuario (`addressId`, que se verifica que sea
 * suya) o una dirección escrita en el propio pedido. Aceptar ambas cosas cubre
 * a quien vuelve a comprar sin haber guardado la dirección.
 */
export const checkoutSchema = z
  .object({
    addressId: z.string().cuid('Dirección inválida').optional(),
    shippingAddress: addressSchema.optional(),
    billingSameAsShipping: z.boolean().default(true),
    billingAddress: addressSchema.optional(),
    paymentMethod: z.enum(['CARD', 'TRANSFER', 'CASH_ON_DELIVERY', 'WALLET']),
    couponCode: z
      .string()
      .trim()
      .max(40)
      .transform((code) => code.toUpperCase())
      .optional(),
    notes: z.string().trim().max(500).optional(),
    phone: z.string().trim().max(30).optional()
  })
  .superRefine((data, ctx) => {
    if (!data.addressId && !data.shippingAddress) {
      ctx.addIssue({
        code: 'custom',
        path: ['shippingAddress'],
        message: 'Indica una dirección guardada (addressId) o los datos de envío'
      });
    }
    if (!data.billingSameAsShipping && !data.billingAddress) {
      ctx.addIssue({
        code: 'custom',
        path: ['billingAddress'],
        message: 'Si la factura es distinta, indica sus datos'
      });
    }
  });

export const orderKeyParamSchema = z.object({
  // Cabe tanto el número legible (EXT-2026-1A2B3C4D, 18) como un cuid (25).
  key: z.string().trim().min(1).max(40)
});

export const cancelOrderSchema = z.object({
  reason: z.string().trim().min(3, 'Explica el motivo de la cancelación').max(255)
});

export const listOrdersQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  perPage: z.coerce.number().int().positive().max(50).default(10)
});
