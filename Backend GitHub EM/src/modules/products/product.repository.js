import { prisma } from '../../config/database.js';

/**
 * ÚNICA capa que habla con la base de datos.
 * No conoce req/res ni mensajes de error: devuelve datos o lanza.
 */

/** Includes reutilizables: definir el "select" en un sitio y no repetirlo. */
const listInclude = {
  variants: {
    where: { isActive: true },
    orderBy: { position: 'asc' },
    include: { colorValue: true, sizeValue: true }
  },
  images: { orderBy: { position: 'asc' } },
  category: true,
  brand: true,
  attributes: { include: { attribute: true, value: true } }
};

const detailInclude = {
  ...listInclude,
  reviews: {
    where: { isApproved: true },
    orderBy: { createdAt: 'desc' },
    take: 10,
    include: { user: { select: { firstName: true } } }
  }
};

/**
 * Búsqueda full-text. Prisma solo expone `fullTextSearch` en MongoDB, así que
 * para el índice `ft_products_name_description` de MySQL usamos SQL parametrizado
 * ($queryRaw con tagged template = seguro frente a inyección).
 */
export async function findProductIdsByFullText(term) {
  const rows = await prisma.$queryRaw`
    SELECT id
    FROM products
    WHERE MATCH(name, description) AGAINST (${term} IN NATURAL LANGUAGE MODE)
    LIMIT 200
  `;
  return rows.map((row) => row.id);
}

export async function findAttributeValueIds(attributeSlug, values) {
  const rows = await prisma.attributeValue.findMany({
    where: { value: { in: values }, attribute: { slug: attributeSlug } },
    select: { id: true }
  });
  return rows.map((row) => row.id);
}

/** Convierte el query validado en un `where` de Prisma. */
export function buildWhere(filters = {}) {
  const and = [];

  // Solo visibles al público. `publishedAt` en el futuro = programado.
  and.push({ status: 'ACTIVE', publishedAt: { lte: new Date() } });

  if (filters.category) and.push({ category: { slug: filters.category } });
  if (filters.brand) and.push({ brand: { slug: filters.brand } });
  if (filters.featured !== undefined) and.push({ isFeatured: filters.featured });
  if (filters.onSale) and.push({ salePrice: { not: null } });

  if (filters.fullTextIds?.length) {
    and.push({ id: { in: filters.fullTextIds } });
  }

  // Precio: se filtra por la columna desnormalizada `current_price`
  // (= COALESCE(sale_price, base_price)), que sí tiene índice. Comparar dos
  // columnas con COALESCE es imposible en Prisma y en SQL usaría full scan.
  if (filters.minPrice !== undefined || filters.maxPrice !== undefined) {
    const currentPrice = {};
    if (filters.minPrice !== undefined) currentPrice.gte = filters.minPrice;
    if (filters.maxPrice !== undefined) currentPrice.lte = filters.maxPrice;
    and.push({ currentPrice });
  }

  // Talla y color deben cumplirse en la MISMA variante (AND), no en variantes
  // distintas: "azul en M" ≠ "hay una azul y hay una M".
  const variantFilters = [];
  if (filters.sizeIds?.length) variantFilters.push({ sizeValueId: { in: filters.sizeIds } });
  if (filters.colorIds?.length) variantFilters.push({ colorValueId: { in: filters.colorIds } });
  if (filters.inStock) variantFilters.push({ isActive: true, stock: { gt: 0 } });

  if (variantFilters.length) and.push({ variants: { some: { AND: variantFilters } } });

  // Material es un atributo de producto (no de variante).
  if (filters.materialIds?.length) {
    and.push({
      attributes: { some: { attribute: { slug: 'material' }, valueId: { in: filters.materialIds } } }
    });
  }

  return { AND: and };
}

function buildOrderBy(sort) {
  switch (sort) {
    case 'price_asc':
      return [{ currentPrice: 'asc' }, { id: 'asc' }];
    case 'price_desc':
      return [{ currentPrice: 'desc' }, { id: 'asc' }];
    case 'rating':
      return [{ ratingAvg: 'desc' }, { ratingCount: 'desc' }];
    case 'name_asc':
      return [{ name: 'asc' }];
    case 'name_desc':
      return [{ name: 'desc' }];
    case 'relevance':
    case 'newest':
    default:
      return [{ publishedAt: 'desc' }, { createdAt: 'desc' }];
  }
}

/**
 * Toda escritura de precio debe pasar por aquí para mantener `current_price`.
 * Sin esto, un ORDER BY price devolvería datos inconsistentes.
 *
 *   await prisma.product.update({
 *     where: { id },
 *     data: withCurrentPrice({ basePrice: 29.9, salePrice: 24.9 })
 *   })
 *
 * El `data.currentPrice ??` de delante respeta el valor que haya calculado el
 * service: en un PATCH que solo quita la oferta, el servicio conoce el precio
 * base existente y esta función no.
 */
export function withCurrentPrice(data) {
  const touchesPrice = data.basePrice !== undefined || data.salePrice !== undefined;
  if (!touchesPrice) return data;

  return {
    ...data,
    currentPrice: data.currentPrice ?? data.salePrice ?? data.basePrice
  };
}

/** Slug único: base, base-2, base-3… (ignora el propio producto al actualizar). */
export async function findUniqueSlug(base, excludeId) {
  let candidate = base;
  let suffix = 1;

  // El índice único de `slug` garantiza que no habrá carreras; esto solo evita
  // el error por la vía rápida.
  /* eslint-disable no-await-in-loop */
  while (
    await prisma.product.findFirst({
      where: { slug: candidate, ...(excludeId && { id: { not: excludeId } }) },
      select: { id: true }
    })
  ) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }
  /* eslint-enable no-await-in-loop */

  return candidate;
}

export function skuExists(sku) {
  return prisma.product.findFirst({ where: { sku }, select: { id: true } });
}

export function variantSkuExists(sku) {
  return prisma.productVariant.findFirst({ where: { sku }, select: { id: true } });
}

/**
 * Alta de producto con variantes, imágenes y colecciones en UNA transacción:
 * o se crea todo, o no queda ni el producto a medias.
 *
 * Recibe el mismo objeto que devuelve `prepareProductInput` del service, así
 * que el servicio es el único que decide nombres, slugs y precios.
 */
export function createProductWithVariants(data) {
  const { variants, collectionIds, ...product } = data;

  return prisma.$transaction(async (tx) =>
    tx.product.create({
      data: {
        ...withCurrentPrice(product),
        variants: { create: variants },
        ...(collectionIds?.length && {
          collectionItems: { create: collectionIds.map((collectionId) => ({ collectionId })) }
        })
      },
      include: detailInclude
    })
  );
}

export function updateProduct(id, data) {
  return prisma.product.update({
    where: { id },
    data: withCurrentPrice(data),
    include: detailInclude
  });
}

/**
 * Baja lógica: un producto con pedidos NO se borra, se archiva.
 * Un DELETE duro dejaría los `order_items` huérfanos (Restrict) y rompería
 * el historial de compras de clientes.
 */
export function archiveProduct(id) {
  return prisma.product.update({
    where: { id },
    data: { status: 'ARCHIVED', publishedAt: null, isFeatured: false },
    include: detailInclude
  });
}

export function countOrderItemsOf(productId) {
  return prisma.orderItem.count({ where: { productId } });
}

/** Borrado duro, permitido solo si el producto nunca se ha vendido. */
export function deleteProduct(id) {
  return prisma.product.delete({ where: { id } });
}

export function createVariant(productId, data) {
  return prisma.productVariant.create({
    data: { ...data, productId },
    include: { colorValue: true, sizeValue: true }
  });
}

export function updateVariant(id, data) {
  return prisma.productVariant.update({
    where: { id },
    data,
    include: { colorValue: true, sizeValue: true }
  });
}

export function findVariantById(id) {
  return prisma.productVariant.findUnique({
    where: { id },
    include: { product: true }
  });
}

/**
 * Ajuste de stock con control de concurrencia.
 *
 * El `stock` se lee y se escribe dentro de una transacción. Prisma no expone
 * bloqueos de fila (`SELECT ... FOR UPDATE`), así que usamos compare-and-swap:
 * el update incluye el valor leído como condición. Si otro proceso cambió el
 * stock entre medias, `count` será 0 y sabremos que hay que reintentar.
 */
export async function adjustStock(variantId, { absolute, delta }) {
  return prisma.$transaction(async (tx) => {
    const variant = await tx.productVariant.findUnique({
      where: { id: variantId },
      select: { id: true, stock: true }
    });
    if (!variant) throw new Error('VARIANT_NOT_FOUND');

    const nextStock = absolute !== undefined ? absolute : variant.stock + delta;
    if (nextStock < 0) throw new Error('NEGATIVE_STOCK');

    const updated = await tx.productVariant.updateMany({
      where: { id: variantId, stock: variant.stock }, //compare-and-swap
      data: { stock: nextStock }
    });

    if (updated.count === 0) throw new Error('STOCK_CONFLICT');
    return { id: variantId, previousStock: variant.stock, stock: nextStock };
  });
}

export function createImage({ id, productId, variantId, url, altText, position, data, mime, bytes }) {
  return prisma.productImage.create({
    data: {
      id,
      productId,
      variantId: variantId ?? null,
      url,
      altText: altText ?? null,
      position,
      data: data ?? null,
      mime: mime ?? null,
      bytes: bytes ?? null
    }
  });
}

/**
 * Binario de una imagen subida. Devuelve null si el id no existe, si la imagen
 * es de seed (URL externa) o si ya se borró el binario.
 */
export function findImageData(id) {
  return prisma.productImage.findFirst({
    where: { id, data: { not: null } },
    select: { data: true, mime: true, bytes: true }
  });
}

export function deleteImage(id) {
  return prisma.productImage.deleteMany({ where: { id } });
}

/** Fila de imagen por id (cualquier origen: subida o de seed). */
export function findImageById(id) {
  return prisma.productImage.findUnique({
    where: { id },
    select: { id: true, productId: true }
  });
}

/**
 * Facetas del catálogo para los filtros de la tienda: categorías con su número
 * de productos, y los valores de talla y color que existen de verdad.
 *
 * Sin esto, el frontend tendría que deducir las categorías de la página que ha
 * cargado, y un filtro construido así desaparece en cuanto el producto sale de
 * la primera página: el usuario vería una categoría que "no existe" solo
 *porque hay más de 12 productos.
 *
 * Solo se cuentan productos ACTIVE: un DRAFT no debe abrir una categoría en la
 * tienda pública, aunque sí aparece en el panel de administración.
 */
export async function findFacets() {
  const ACTIVE = { status: 'ACTIVE' };
  const SELLABLE = { isActive: true, product: ACTIVE };

  const [categories, sizeValues, colorValues, variantLinks] = await Promise.all([
    prisma.category.findMany({
      where: { isActive: true, products: { some: ACTIVE } },
      orderBy: [{ position: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        slug: true,
        _count: { select: { products: { where: ACTIVE } } }
      }
    }),
    prisma.attributeValue.findMany({
      where: { attribute: { slug: 'talla', isFilterable: true } },
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, value: true }
    }),
    prisma.attributeValue.findMany({
      where: { attribute: { slug: 'color', isFilterable: true } },
      orderBy: [{ position: 'asc' }, { label: 'asc' }],
      select: { id: true, label: true, value: true, hexColor: true }
    }),
    /**
     * ONLY ESO de cada variante: un producto tiene 40 variantes (talla × color)
     * y la pantalla necesita contar PRODUCTOS distintos por talla, no variantes.
     * Traer solo los dos identificadores mantiene la carga ridícula frente a
     * traer las variantes enteras, y el groupBy en memoria es trivial a esta
     * escala. Con un catálogo de diez mil variantes habría que mover esto a un
     * COUNT(DISTINCT product_id) en SQL.
     */
    prisma.productVariant.findMany({
      where: SELLABLE,
      select: { sizeValueId: true, colorValueId: true, productId: true }
    })
  ]);

  const countDistinctProducts = (key, valueId) => {
    let count = 0;
    for (const variant of variantLinks) {
      if (variant[key] !== valueId) continue;
      // productsIds viene con repeticiones (una por variante de esa talla): solo
      // nos importa si ese producto ya estaba contado.
      if (!counted.has(`${valueId}:${variant.productId}`)) {
        counted.add(`${valueId}:${variant.productId}`);
        count += 1;
      }
    }
    return count;
  };

  const counted = new Set();

  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      slug: category.slug,
      count: category._count.products
    })),
    sizes: sizeValues
      .map((value) => ({ ...value, count: countDistinctProducts('sizeValueId', value.id) }))
      .filter((value) => value.count > 0),
    colors: colorValues
      .map((value) => ({ ...value, count: countDistinctProducts('colorValueId', value.id) }))
      .filter((value) => value.count > 0)
  };
}

export async function findMany({ where, sort, page, perPage, includeVariants }) {
  const skip = (page - 1) * perPage;

  const [total, items] = await Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip,
      take: perPage,
      orderBy: buildOrderBy(sort),
      include: includeVariants ? listInclude : { ...listInclude, variants: false, images: { orderBy: { position: 'asc' }, take: 1 } }
    })
  ]);

  return { items, total };
}

/**
 * Búsqueda para el panel de administración: sin filtro de estado, porque un
 * producto archivado o en borrador también se tiene que poder editar.
 * `findByKey` (público) sí exige ACTIVE + publishedAt.
 */
export function findEditableByKey(key) {
  const isCuid = /^[a-z0-9]{20,32}$/i.test(key);

  return prisma.product.findFirst({
    where: isCuid ? { id: key } : { slug: key.toLowerCase() },
    include: detailInclude
  });
}

/**
 * Include del panel: igual que el del listado público, pero con TODAS las
 * variantes, incluidas las desactivadas. El panel necesita ver una variante
 * desactivada para poder reactivarla o ajustar su stock.
 */
const adminListInclude = {
  ...listInclude,
  variants: {
    orderBy: { position: 'asc' },
    include: { colorValue: true, sizeValue: true }
  }
};

/**
 * Where del listado de admin. A diferencia de `buildWhere`, NO fuerza
 * status ACTIVE: el panel ve borradores y archivados, y filtra por estado
 * solo cuando se lo piden.
 */
export function buildAdminWhere(filters = {}) {
  const and = [];

  if (filters.status) and.push({ status: filters.status });
  if (filters.categoryId) and.push({ categoryId: filters.categoryId });
  if (filters.featured !== undefined) and.push({ isFeatured: filters.featured });
  if (filters.q) {
    // `contains` de Prisma va parametrizado: no es concatenación de SQL.
    and.push({
      OR: [{ name: { contains: filters.q } }, { sku: { contains: filters.q } }]
    });
  }

  return { AND: and };
}

export function findManyForAdmin({ where, page, perPage }) {
  const skip = (page - 1) * perPage;

  return Promise.all([
    prisma.product.count({ where }),
    prisma.product.findMany({
      where,
      skip,
      take: perPage,
      // Lo primero es lo que se acaba de tocar: el panel casi siempre entra
      // para editar el producto que acaba de crear o cambiar.
      orderBy: [{ updatedAt: 'desc' }],
      include: adminListInclude
    })
  ]).then(([total, items]) => ({ items, total }));
}

/** Devuelve el Set de ids que SÍ existen, para detectar los que faltan. */
export async function findExistingAttributeValues(ids) {
  const rows = await prisma.attributeValue.findMany({
    where: { id: { in: ids } },
    select: { id: true }
  });
  return new Set(rows.map((row) => row.id));
}

export async function findByKey(key, { includeVariants = true } = {}) {
  const isCuid = /^[a-z0-9]{20,32}$/i.test(key);

  return prisma.product.findFirst({
    where: {
      AND: [
        { status: 'ACTIVE', publishedAt: { lte: new Date() } },
        isCuid ? { id: key } : { slug: key.toLowerCase() }
      ]
    },
    include: includeVariants ? detailInclude : listInclude
  });
}

export async function findRelated(productId, categoryId, limit = 4) {
  const products = await prisma.product.findMany({
    where: {
      id: { not: productId },
      status: 'ACTIVE',
      publishedAt: { lte: new Date() },
      ...(categoryId ? { categoryId } : {})
    },
    orderBy: [{ isFeatured: 'desc' }, { ratingAvg: 'desc' }, { publishedAt: 'desc' }],
    take: limit,
    include: listInclude
  });

  // Si la categoría no tiene suficientes, rellenamos con novedades.
  if (products.length < limit) {
    const extra = await prisma.product.findMany({
      where: { id: { notIn: [productId, ...products.map((p) => p.id)] }, status: 'ACTIVE', publishedAt: { lte: new Date() } },
      orderBy: { publishedAt: 'desc' },
      take: limit - products.length,
      include: listInclude
    });
    return [...products, ...extra];
  }

  return products;
}