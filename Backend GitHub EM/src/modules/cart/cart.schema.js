import { z } from 'zod';

/** Máximo de unidades por línea: evita que un cliente se lleve el almacén. */
export const MAX_LINE_QUANTITY = 20;

export const addItemSchema = z.object({
  variantId: z.string().cuid('Identificador de variante inválido'),
  quantity: z.coerce
    .number()
    .int('La cantidad debe ser un número entero')
    .min(1, 'La cantidad mínima es 1')
    .max(MAX_LINE_QUANTITY, `Máximo ${MAX_LINE_QUANTITY} unidades por variante`)
    .default(1)
});

export const updateItemSchema = z.object({
  quantity: z.coerce
    .number()
    .int('La cantidad debe ser un número entero')
    .min(1, 'La cantidad mínima es 1')
    .max(MAX_LINE_QUANTITY, `Máximo ${MAX_LINE_QUANTITY} unidades por variante`)
});

export const itemParamsSchema = z.object({
  itemId: z.string().cuid('Línea de carrito inválida')
});

export const applyCouponSchema = z.object({
  code: z
    .string()
    .trim()
    .min(3, 'El código es demasiado corto')
    .max(40)
    // " bienvenida10 " -> "BIENVENIDA10": los códigos no distinguen mayúsculas.
    .transform((code) => code.toUpperCase())
});
