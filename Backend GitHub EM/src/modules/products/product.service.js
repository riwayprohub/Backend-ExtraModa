import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import { slugify } from '../../utils/slugify.js';
import * as repository from './product.repository.js';
import { toPublicProduct, toProductCard, toAdminProduct, toAdminVariant } from './product.mapper.js';

/**
 * Reglas de negocio del catálogo.
 * No conoce req/res: recibe datos ya validados y devuelve DTOs.
 */

const round2 = (value) => (value === undefined ? undefined : Math.round(value * 100) / 100);

/** SKU automático a partir del nombre: EXT-CAMISETA-ESSENTIAL-01 */
function autoSku(name) {
  return `EXT-${slugify(name).slice(0, 40).toUpperCase()}`;
}

export const productService = {
  // ── Lecturas públicas ──────────────────────────────────────────────────────

  /** Facetas para los filtros de la tienda. */
  async facets() {
    const { categories, sizes, colors } = await repository.findFacets();

    return { categories, sizes, colors };
  },

  async list(query) {
    const {
      page,
      perPage,
      q,
      category,
      brand,
      sizes,
      colors,
      materials,
      minPrice,
      maxPrice,
      inStock,
      featured,
      onSale,
      sort,
      includeVariants = true
    } = query;

    // Resolución de etiquetas → ids de valores de atributo, en paralelo.
    const [fullTextIds, sizeIds, colorIds, materialIds] = await Promise.all([
      q ? repository.findProductIdsByFullText(q) : undefined,
      sizes?.length ? repository.findAttributeValueIds('talla', sizes) : undefined,
      colors?.length ? repository.findAttributeValueIds('color', colors) : undefined,
      materials?.length ? repository.findAttributeValueIds('material', materials) : undefined
    ]);

    // Si se filtra por una talla/color que no existe, el resultado es vacío:
    // devolver el catálogo entero sería confuso (y sería una fuga de datos).
    const unknownFilter =
      (sizes?.length && !sizeIds.length) || (colors?.length && !colorIds.length) ||
      (materials?.length && !materialIds.length);
    if (unknownFilter) {
      return { items: [], total: 0, page, perPage };
    }

    const where = repository.buildWhere({
      category,
      brand,
      minPrice,
      maxPrice,
      inStock,
      featured,
      onSale,
      fullTextIds,
      sizeIds,
      colorIds,
      materialIds
    });

    const { items, total } = await repository.findMany({
      where,
      // "relevance" solo significa algo con búsqueda textual; sin ella, novedades.
      sort: sort === 'relevance' && !q ? 'newest' : sort,
      page,
      perPage,
      includeVariants
    });

    return {
      items: items.map((product) => toPublicProduct(product, { includeVariants })),
      total,
      page,
      perPage
    };
  },

  async getByKey(key) {
    const product = await repository.findByKey(key);

    if (!product) {
      throw AppError.notFound(`No existe ningún producto con la referencia "${key}"`);
    }

    const related = await repository.findRelated(product.id, product.categoryId, 4);

    return {
      product: {
        ...toPublicProduct(product, { includeVariants: true }),
        reviews: product.reviews.map((review) => ({
          id: review.id,
          rating: review.rating,
          title: review.title,
          comment: review.comment,
          author: review.user.firstName,
          isVerifiedPurchase: review.isVerifiedPurchase,
          createdAt: review.createdAt
        }))
      },
      related: related.map(toProductCard)
    };
  },

  /**
   * Listado del panel: incluye DRAFT y ARCHIVED, que el listado público
   * filtra siempre. Sin esto, un producto en borrador sería invisible para
   * quien tiene que terminarlo.
   */
  async listForAdmin(query) {
    const { page, perPage } = query;

    const { items, total } = await repository.findManyForAdmin({
      where: repository.buildAdminWhere(query),
      page,
      perPage
    });

    return {
      items: items.map((product) => toAdminProduct(product, { includeVariants: true })),
      total,
      page,
      perPage
    };
  },

  /**
   * Detalle del panel por slug o id, sea cual sea el estado. El `GET
   * /products/:key` público solo sirve ACTIVE y publicado: para editar un
   * borrador hace falta esta vía.
   */
  async getForAdmin(key) {
    const product = await repository.findEditableByKey(key);

    if (!product) {
      throw AppError.notFound(`No existe ningún producto con la referencia "${key}"`);
    }

    return toAdminProduct(product, { includeVariants: true });
  },

  // ── Escrituras (ADMIN / EDITOR) ────────────────────────────────────────────

  async create(input) {
    const data = await prepareProductInput(input);

    if (await repository.skuExists(data.sku)) {
      throw AppError.duplicate(`El SKU ${data.sku} ya está en uso`, { sku: 'SKU duplicado' });
    }

    if (data.variants.length) await assertUniqueVariantSkus(data.variants);
    await assertAttributeValuesExist(data.variants);

    const product = await repository.createProductWithVariants(data);

    return toAdminProduct(product, { includeVariants: true });
  },

  async update(key, input) {
    const existing = await requireEditableProduct(key);
    const data = { ...input };

    // El slug NO se regenera al cambiar el nombre: cambiarlo rompería las URLs
    // ya indexadas por buscadores. Solo cambia si viene explícito.
    if (data.slug !== undefined) {
      const unique = await repository.findUniqueSlug(data.slug, existing.id);
      if (unique !== data.slug) {
        throw AppError.duplicate(`El slug "${data.slug}" ya existe`, { slug: 'Slug duplicado' });
      }
      data.slug = unique;
    }

    if (data.basePrice !== undefined || data.salePrice !== undefined) {
      await assertPriceConsistent(existing, data);

      /**
       * `withCurrentPrice` del repository solo ve los campos de ESTE patch. Si
       * se quita la oferta sin enviar el precio base, currentPrice tiene que
       * volver al base que ya está en la BD, y ese dato solo lo tiene el
       * service. Se calcula aquí y el repository lo respeta.
       */
      const effectiveBase = data.basePrice ?? Number(existing.basePrice);
      const effectiveSale = data.salePrice === undefined ? existing.salePrice : data.salePrice;
      data.currentPrice = effectiveSale ?? effectiveBase;
    }

    // Volver a ACTIVE exige fecha de publicación; archivar la retira.
    if (data.status === 'ACTIVE' && existing.status !== 'ACTIVE') {
      data.publishedAt = new Date();
    }

    const product = await repository.updateProduct(existing.id, data);
    return toAdminProduct(product, { includeVariants: true });
  },

  /**
   * Baja lógica. Solo se borra de verdad si el producto nunca se ha vendido:
   * un DELETE duro rompería el historial de pedidos (Restrict en order_items).
   */
  async archive(key, { hard = false } = {}) {
    const product = await requireEditableProduct(key);
    const sold = await repository.countOrderItemsOf(product.id);

    if (!hard) {
      const archived = await repository.archiveProduct(product.id);
      return { archived: true, deleted: false, product: toAdminProduct(archived) };
    }

    if (sold > 0) {
      throw AppError.conflict(
        `No se puede eliminar: el producto aparece en ${sold} línea(s) de pedido. Archívalo en su lugar.`,
        { soldLines: sold }
      );
    }

    await repository.deleteProduct(product.id);
    return { archived: false, deleted: true };
  },

  async addVariant(key, input) {
    const product = await requireEditableProduct(key);

    const sku = input.sku ?? (await generateVariantSku(product, input));
    if (await repository.variantSkuExists(sku)) {
      throw AppError.duplicate(`El SKU ${sku} ya existe`, { sku: 'SKU duplicado' });
    }

    await assertAttributeValuesExist([input]);

    const variant = await repository.createVariant(product.id, {
      sku,
      colorValueId: input.colorValueId ?? null,
      sizeValueId: input.sizeValueId ?? null,
      ...inheritPrice(input, {
        basePrice: Number(product.basePrice),
        salePrice: product.salePrice === null ? undefined : Number(product.salePrice)
      }),
      costPrice: round2(input.costPrice),
      stock: input.stock ?? 0
    });

    return toAdminVariant(variant);
  },

  async adjustStock(variantId, payload) {
    const variant = await repository.findVariantById(variantId);
    if (!variant) throw AppError.notFound('La variante no existe');
    if (variant.product.status === 'ARCHIVED') {
      throw AppError.conflict('No se puede ajustar el stock de un producto archivado');
    }

    try {
      const result = await repository.adjustStock(variantId, {
        absolute: payload.stock,
        delta: payload.delta
      });

      const lowStock = result.stock > 0 && result.stock <= 3;
      return { ...result, inStock: result.stock > 0, lowStock };
    } catch (error) {
      if (error.message === 'NEGATIVE_STOCK') {
        throw AppError.conflict('El ajuste dejaría el stock en negativo');
      }
      if (error.message === 'STOCK_CONFLICT') {
        throw AppError.conflict(
          'El stock cambió mientras ajustábamos. Vuelve a intentarlo.',
          { code: 'STOCK_CONFLICT' }
        );
      }
      if (error.message === 'VARIANT_NOT_FOUND') throw AppError.notFound('La variante no existe');
      throw error;
    }
  },

  async addImage(key, file, { altText, position }) {
    const product = await requireEditableProduct(key);
    if (!file) throw AppError.badRequest('No se ha recibido ningún archivo (campo "image")');

    // El id lo generamos nosotros para poder escribir la URL pública en la misma
    // instrucción: si dejáramos que lo pusiera la base, habría que hacer un
    // UPDATE después solo para rellenar la url.
    const id = crypto.randomUUID();
    const image = await repository.createImage({
      id,
      productId: product.id,
      url: `/api/v1/images/${id}`,
      altText,
      position,
      data: file.buffer,
      mime: file.mimetype,
      bytes: file.size
    });

    return { id: image.id, url: image.url, altText: image.altText, position: image.position };
  },

  /**
   * Borrado de una foto concreta por su id (no por slug): desde el panel se
   * elimina la imagen que se ve, y esa imagen tiene id propio.
   *
   * Las imágenes de seed (URL externa, `data = null`) también se borran: lo
   * que se elimina es la fila, no el binario, y una fila sin binario es
   * exactamente lo que hay que quitar para que la foto desaparezca.
   */
  async removeImage(imageId) {
    const image = await repository.findImageById(imageId);
    if (!image) throw AppError.notFound('Esa imagen no existe');

    await repository.deleteImage(imageId);
    return { id: imageId, productId: image.productId };
  }
};

// ── Auxiliares ────────────────────────────────────────────────────────────────

/**
 * Una variante sin precio propio hereda el del producto, Y TAMBIÉN su oferta.
 * Si no, el catálogo mostraría "99,50 €" en la ficha y "129,95 €" al elegir
 * talla, que es exactamente el tipo de descuadre que genera devoluciones.
 */
function inheritPrice(variant, product) {
  const price = variant.price ?? product.basePrice;
  const salePrice = variant.salePrice ?? (variant.price === undefined ? product.salePrice : undefined);

  return {
    price: round2(price),
    salePrice: round2(salePrice)
  };
}

/** Normaliza la entrada antes de tocar la BD (precios redondeados, slug, fechas). */
async function prepareProductInput(input) {
  const name = input.name.trim();
  const slug = await repository.findUniqueSlug(input.slug ?? slugify(name));

  // `ProductVariant.sku` es obligatorio en el schema, así que si el cliente no
  // lo manda lo derivamos del SKU del producto + nº de variante.
  const variants = (input.variants ?? []).map((variant, index) => ({
    sku: variant.sku ?? `${input.sku}-${String(index + 1).padStart(2, '0')}`,
    colorValueId: variant.colorValueId ?? null,
    sizeValueId: variant.sizeValueId ?? null,
    ...inheritPrice(variant, { basePrice: input.basePrice, salePrice: input.salePrice }),
    costPrice: round2(variant.costPrice),
    stock: variant.stock ?? 0
  }));

  return {
    name,
    slug,
    sku: input.sku,
    shortDescription: input.shortDescription ?? null,
    description: input.description,
    basePrice: round2(input.basePrice),
    salePrice: round2(input.salePrice),
    taxRate: input.taxRate ?? 0.21,
    categoryId: input.categoryId ?? null,
    brandId: input.brandId ?? null,
    weightGrams: input.weightGrams ?? null,
    isFeatured: input.isFeatured ?? false,
    status: input.status ?? 'DRAFT',
    publishedAt: input.status === 'ACTIVE' ? new Date() : null,
    collectionIds: input.collectionIds,
    variants
  };
}

/** Localiza el producto por slug o id, sea del estado que sea. */
async function requireEditableProduct(key) {
  const found = await repository.findEditableByKey(key);

  if (!found) throw AppError.notFound(`No existe ningún producto con la referencia "${key}"`);
  return found;
}

async function assertUniqueVariantSkus(variants) {
  const skus = variants.map((variant) => variant.sku).filter(Boolean);
  if (skus.length !== new Set(skus).size) {
    throw AppError.badRequest('Hay variantes con el mismo SKU dentro de la misma petición');
  }
}

/** Un id de color/talla que no existe rompería los filtros del catálogo. */
async function assertAttributeValuesExist(variants) {
  const ids = variants.flatMap((variant) => [variant.colorValueId, variant.sizeValueId]).filter(Boolean);
  if (!ids.length) return;

  const found = await repository.findExistingAttributeValues(ids);
  const missing = ids.filter((id) => !found.has(id));

  if (missing.length) {
    throw AppError.badRequest('Color o talla inexistentes', { attributeValues: missing.join(', ') });
  }
}

/**
 * Regla de negocio: la oferta de una variante tampoco puede superar su precio.
 * Al cambiar solo el precio del producto hay que revalidar las variantes que
 * heredaban ese precio.
 */
async function assertPriceConsistent(existing, data) {
  const newBase = data.basePrice ?? Number(existing.basePrice);
  const newSale = data.salePrice === undefined ? existing.salePrice : data.salePrice;

  if (newSale && Number(newSale) >= newBase) {
    throw AppError.badRequest('El precio de oferta debe ser menor que el precio base', {
      salePrice: 'Debe ser menor que el precio base'
    });
  }

  const variants = existing.variants ?? [];
  const offenders = variants.filter(
    (variant) => Number(variant.salePrice) >= newBase || Number(variant.price) > newBase
  );

  if (offenders.length) {
    throw AppError.conflict(
      `Hay ${offenders.length} variante(s) con precio o oferta por encima del nuevo precio base. Ajusta esas variantes primero.`,
      { conflictingVariants: offenders.map((variant) => variant.sku) }
    );
  }
}

async function generateVariantSku(product, input) {
  const base = product.sku || autoSku(product.name);
  const suffix = [
    input.colorValueId ? input.colorValueId.slice(-3).toUpperCase() : 'UNICO',
    input.sizeValueId ? input.sizeValueId.slice(-3).toUpperCase() : 'STD'
  ].join('-');
  return `${base}-${suffix}`.slice(0, 64);
}