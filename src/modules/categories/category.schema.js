import { z } from 'zod';

/**
 * Validaciones del módulo de categorías.
 *
 * Mismo enfoque que el resto de módulos: Zod valida en el borde (controller) y
 * el service recibe datos ya saneados. Los query params que llegan como texto
 * se coercionan aquí, no en el repository.
 */

const name = z
  .string()
  .trim()
  .min(2, 'El nombre debe tener al menos 2 caracteres')
  .max(120);

const slug = z
  .string()
  .trim()
  .toLowerCase()
  .max(191)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'El slug solo admite minúsculas, números y guiones');

const description = z.string().trim().max(2000);

const imageUrl = z.string().trim().max(255);

const parentId = z.string().cuid('Identificador de categoría padre inválido');

const position = z.coerce.number().int().min(0, 'La posición no puede ser negativa').max(9999);

export const categoryIdParamSchema = z.object({
  id: z.string().cuid('Identificador de categoría inválido')
});

/** Campos comunes. `required` decide qué es obligatorio en el alta. */
const categoryFields = (required = []) => {
  const field = (name_, schema) => (required.includes(name_) ? schema : schema.optional());
  return {
    name: field('name', name),
    slug: field('slug', slug),
    description: field('description', description),
    imageUrl: field('imageUrl', imageUrl),
    parentId: field('parentId', parentId),
    position: field('position', position),
    isActive: field('isActive', z.boolean())
  };
};

export const createCategorySchema = z.object(categoryFields(['name']));

export const updateCategorySchema = z
  .object({
    ...categoryFields(),
    // `null` explícito desengancha la subcategoría de su padre: un optional a
    // secas no distinguiría "no tocar este campo" de "convertirla en raíz".
    parentId: z.union([parentId, z.null()]).optional()
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Envía al menos un campo para actualizar' });
    }
  });

/** Reordenación en bloque: la posición de cada categoría es su índice. */
export const reorderCategoriesSchema = z.object({
  ids: z
    .array(z.string().cuid('Identificador de categoría inválido'))
    .min(1, 'Indica al menos una categoría')
    .max(100, 'No se pueden reordenar más de 100 categorías a la vez')
});
