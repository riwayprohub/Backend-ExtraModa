import { z } from 'zod';

/**
 * Un query param siempre llega como texto. Estos helpers normalizan y limitan
 * los valores ANTES de que lleguen al repository: nunca filtres con
 * `${req.query.q}` directo en un `LIKE`.
 */

/**
 * ?sizes=s,m,l  →  ['s','m','l']
 * Cadena vacía o ausente → undefined (es decir, "sin filtro", no un error):
 * es lo que espera un usuario que escribe el filtro y ve que no aplica.
 */
const csv = (maxItems = 20) =>
  z
    .string()
    .trim()
    .max(400)
    .optional()
    .transform((value) =>
      value
        ? [...new Set(value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean))].slice(0, maxItems)
        : undefined
    );

/** 'true' | 'false' | undefined → true | false | undefined */
const boolParam = z.preprocess(
  (value) => (value === undefined || value === '' ? undefined : value === true || value === 'true'),
  z.boolean().optional()
);

const decimalParam = z.coerce
  .number({ error: 'Debe ser un número' })
  .min(0, 'No puede ser negativo')
  .max(100_000, 'Precio demasiado alto')
  .optional();

export const listProductsQuerySchema = z
  .object({
    page: z.coerce
      .number({ error: 'Debe ser un número' })
      .int('Debe ser un número entero')
      .min(1, 'La página empieza en 1')
      .default(1),
    perPage: z.coerce
      .number({ error: 'Debe ser un número' })
      .int('Debe ser un número entero')
      .min(1, 'Mínimo 1 producto por página')
      .max(60, 'Máximo 60 productos por página')
      .default(12),

    q: z.string().trim().min(2, 'Mínimo 2 caracteres').max(120).optional(),

    category: z.string().trim().toLowerCase().max(120).optional(),
    brand: z.string().trim().toLowerCase().max(120).optional(),

    sizes: csv(10),
    colors: csv(20),
    materials: csv(20),

    minPrice: decimalParam,
    maxPrice: decimalParam,
    inStock: boolParam,
    featured: boolParam,
    onSale: boolParam,

    sort: z
      .enum(['relevance', 'newest', 'price_asc', 'price_desc', 'rating', 'name_asc', 'name_desc'])
      .default('relevance'),

    includeVariants: boolParam
  })
  .refine((data) => data.minPrice === undefined || data.maxPrice === undefined || data.minPrice <= data.maxPrice, {
    message: 'minPrice no puede ser mayor que maxPrice',
    path: ['minPrice']
  });

export const productKeyParamSchema = z.object({
  key: z.string().trim().min(1).max(191)
});

export const archiveQuerySchema = z.object({
  hard: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true')
});

/**
 * Listado del panel de administración. A diferencia del público, aquí SÍ se
 * puede filtrar por estado: un borrador o un archivado tienen que aparecer
 * para poder seguir editándolos.
 */
export const listProductsAdminQuerySchema = z.object({
  q: z.string().trim().min(1, 'Escribe al menos un carácter').max(120).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  categoryId: z.string().cuid().optional(),
  featured: boolParam,
  page: z.coerce
    .number({ error: 'Debe ser un número' })
    .int()
    .min(1)
    .default(1),
  perPage: z.coerce
    .number({ error: 'Debe ser un número' })
    .int()
    .min(1)
    .max(60)
    .default(20)
});

// ── Escrituras (requieren authenticate + authorize) ──────────────────────────

const price = z.coerce
  .number({ error: 'Debe ser un número' })
  .min(0, 'El precio no puede ser negativo')
  .max(100_000, 'Precio demasiado alto');

const money2 = (value) => Math.round(value * 100) / 100; // evita 19.900000000000002

const skuField = z
  .string()
  .trim()
  .toUpperCase()
  .min(3, 'El SKU debe tener al menos 3 caracteres')
  .max(64)
  .regex(/^[A-Z0-9-]+$/, 'El SKU solo admite letras, números y guiones');

export const variantInputSchema = z.object({
  sku: skuField.optional(),
  colorValueId: z.string().cuid().optional(),
  sizeValueId: z.string().cuid().optional(),
  // Si no se indica, la variante hereda el precio del producto
  price: price.optional(),
  salePrice: price.optional(),
  costPrice: price.optional(),
  stock: z.coerce.number().int().min(0, 'El stock no puede ser negativo').max(1_000_000).default(0)
});

/**
 * Campos comunes de producto.
 * `required` decide cuáles son obligatorios: en el alta son 3, en el PATCH
 * ninguno (actualización parcial).
 */
const productFields = (required = []) => {
  const field = (name, schema) => (required.includes(name) ? schema : schema.optional());
  return {
    name: field(
      'name',
      z.string().trim().min(3, 'El nombre debe tener al menos 3 caracteres').max(180)
    ),
    slug: field(
      'slug',
      z
        .string()
        .trim()
        .toLowerCase()
        .max(191)
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'El slug solo admite minúsculas, números y guiones')
    ),
    shortDescription: field('shortDescription', z.string().trim().max(300)),
    description: field(
      'description',
      z.string().trim().min(10, 'Describe el producto con al menos 10 caracteres').max(5000)
    ),
    basePrice: field('basePrice', price),
    salePrice: field('salePrice', price),
    taxRate: field('taxRate', z.coerce.number().min(0).max(1)),
    categoryId: field('categoryId', z.string().cuid()),
    brandId: field('brandId', z.string().cuid()),
    weightGrams: field('weightGrams', z.coerce.number().int().min(0).max(100_000)),
    isFeatured: field('isFeatured', z.boolean()),
    status: field('status', z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']))
  };
};

const REQUIRED_ON_CREATE = ['name', 'description', 'basePrice'];

/** El precio de oferta nunca puede superar el precio base. */
const priceRules = (data) => {
  if (data.salePrice === undefined || data.basePrice === undefined) return null;
  if (data.salePrice < data.basePrice) return null;
  return {
    path: ['salePrice'],
    message: 'El precio de oferta debe ser menor que el precio base'
  };
};

export const createProductSchema = z
  .object({
    ...productFields(REQUIRED_ON_CREATE),
    sku: skuField,
    variants: z.array(variantInputSchema).max(200).optional().default([]),
    collectionIds: z.array(z.string().cuid()).max(10).optional()
  })
  .superRefine((data, ctx) => {
    const issue = priceRules(data);
    if (issue) ctx.addIssue({ code: 'custom', ...issue });
    if (data.taxRate !== undefined && data.taxRate > 1) {
      ctx.addIssue({ code: 'custom', path: ['taxRate'], message: 'Usa 0.21 para un 21 % de IVA' });
    }
  });

export const updateProductSchema = z
  .object({
    ...productFields(),
    /**
     * En el PATCH, `salePrice: null` BORRA la oferta. En el alta no: allí un
     * `null` se colaría como 0 (producto gratis) por el redondeo de
     * `prepareProductInput`, así que la nulidad es solo cosa de la
     * actualización.
     */
    salePrice: price.nullable().optional()
  })
  .superRefine((data, ctx) => {
    if (Object.keys(data).length === 0) {
      ctx.addIssue({ code: 'custom', message: 'Envía al menos un campo para actualizar' });
    }
    const issue = priceRules(data);
    if (issue) ctx.addIssue({ code: 'custom', ...issue });
  });

export const createVariantSchema = z
  .object(variantInputSchema.shape)
  .superRefine((data, ctx) => {
    const issue = priceRules(data);
    if (issue) ctx.addIssue({ code: 'custom', ...issue });
  });

/** Ajuste de stock: absoluto (`stock`) o relativo (`delta`). Nunca ambos. */
export const adjustStockSchema = z
  .object({
    delta: z.coerce.number().int().min(-100_000).max(100_000).optional(),
    stock: z.coerce.number().int().min(0).max(1_000_000).optional(),
    reason: z.string().trim().max(255).optional()
  })
  .refine((data) => (data.delta === undefined) !== (data.stock === undefined), {
    message: 'Indica `delta` (variación) o `stock` (nuevo absoluto), no ambos'
  });

export const variantParamsSchema = z.object({
  variantId: z.string().cuid('Identificador de variante inválido')
});

export const addImageSchema = z.object({
  altText: z.string().trim().max(160).optional(),
  position: z.coerce.number().int().min(0).max(999).default(0)
});

/**
 * Id de imagen subida: lo genera `crypto.randomUUID()`, así que es un UUID v4.
 * Se limita el formato ANTES de tocar la base: un id arbitrario en la URL
 * acabaría en un SELECT con una cadena que el visitante controla.
 */
export const imageIdParamSchema = z.object({
  id: z.string().uuid('Identificador de imagen inválido')
});

/**
 * Id de imagen para el borrado desde el panel. Acepta los DOS formatos que
 * existen en la tabla: UUID v4 de las imágenes subidas por el administrador
 * (`crypto.randomUUID()`) y cuid de las imágenes del seed. El id va
 * parametrizado a Prisma, así que no hay riesgo de inyección por soltarlo.
 */
export const productImageParamSchema = z.object({
  imageId: z
    .string()
    .trim()
    .min(10, 'Identificador de imagen inválido')
    .max(64)
    .regex(/^[a-z0-9-]+$/i, 'Identificador de imagen inválido')
});

export const priceFields = { price, money2 };