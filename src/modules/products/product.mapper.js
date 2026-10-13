/**
 * Mapeo de entidades → DTOs públicos.
 *
 * REGLA DE ORO: aquí se construye la respuesta con una lista EXPLÍCITA de
 * campos, nunca con `...variant`. Si mañana añades `costPrice` al schema, esta
 * función sigue sin filtrarlo. El allowlist es la barrera; no la confianza.
 */

const money = (value) => (value === null || value === undefined ? null : Number(value.toFixed(2)));

/** Precio efectivo = oferta si existe, si no precio base. */
const effectivePrice = (listPrice, salePrice) => {
  const base = listPrice ?? salePrice;
  const price = salePrice ?? listPrice;
  const hasDiscount = Boolean(salePrice) && base && Number(salePrice) < Number(base);
  return {
    price: money(price),
    compareAtPrice: hasDiscount ? money(base) : null,
    discountPercentage: hasDiscount ? Math.round((1 - Number(salePrice) / Number(base)) * 100) : 0
  };
};

export function toPublicVariant(variant) {
  const available = Math.max(0, variant.stock - variant.reservedStock);

  return {
    id: variant.id,
    sku: variant.sku,
    name: variant.name,
    barcode: variant.barcode,
    ...effectivePrice(variant.price, variant.salePrice),

    // costPrice, barcodes internos de proveedor y reservedStock NO se exponen:
    // son datos de negocio. reservedStock solo alimenta `stockAvailable`.
    color: variant.colorValue
      ? {
          id: variant.colorValue.id,
          label: variant.colorValue.label,
          value: variant.colorValue.value,
          hexColor: variant.colorValue.hexColor
        }
      : null,
    size: variant.sizeValue
      ? { id: variant.sizeValue.id, label: variant.sizeValue.label, value: variant.sizeValue.value }
      : null,

    stockAvailable: available,
    inStock: available > 0,
    lowStock: available > 0 && available <= 3,
    isActive: variant.isActive
  };
}

export function toPublicProduct(product, { includeVariants = true } = {}) {
  const variants = includeVariants ? product.variants.map(toPublicVariant) : [];
  const sellableVariants = variants.filter((variant) => variant.isActive);

  const availableSizes = dedupe(
    sellableVariants.filter((v) => v.size).map((v) => v.size.label)
  );
  const availableColors = dedupe(
    sellableVariants.filter((v) => v.color).map((v) => v.color.label)
  );

  return {
    id: product.id,
    sku: product.sku,
    name: product.name,
    slug: product.slug,
    shortDescription: product.shortDescription,
    ...(includeVariants ? { description: product.description } : {}),

    ...effectivePrice(product.basePrice, product.salePrice),
    taxRate: Number(product.taxRate),

    isFeatured: product.isFeatured,
    rating: {
      average: Number(product.ratingAvg ?? 0),
      count: product.ratingCount
    },

    category: product.category
      ? { id: product.category.id, name: product.category.name, slug: product.category.slug }
      : null,
    brand: product.brand ? { id: product.brand.id, name: product.brand.name, slug: product.brand.slug } : null,

    images: product.images.map((image) => ({
      url: image.url,
      altText: image.altText ?? product.name,
      position: image.position
    })),

    inStock: sellableVariants.some((variant) => variant.inStock),
    availableSizes,
    availableColors,

    ...(includeVariants
      ? {
          variants,
          attributes: product.attributes.map((attribute) => ({
            name: attribute.attribute.name,
            slug: attribute.attribute.slug,
            value: attribute.value.label
          }))
        }
      : {})
  };
}

/** Resumen para “productos relacionados” (sin descripción ni variantes). */
export function toProductCard(product) {
  return toPublicProduct(product, { includeVariants: false });
}

// ── DTO de administración ────────────────────────────────────────────────────

/**
 * Lo que necesita el panel de gestión: TODO lo público + el estado interno y
 * los márgenes.
 *
 * `costPrice` sí aparece aquí, a diferencia del DTO público: solo un
 * ADMIN/EDITOR autenticado llega a estas rutas, y sin coste de compra no se
 * puede calcular el margen ni el precio de venta. La barrera sigue siendo el
 * rol, no el mapper.
 */
export function toAdminVariant(variant) {
  return {
    ...toPublicVariant(variant),
    // `price` del DTO público es el precio EFECTIVO (con oferta aplicada).
    // El panel necesita el desglose para poder cambiar los precios.
    basePrice: Number(variant.price),
    salePrice: variant.salePrice === null ? null : Number(variant.salePrice),
    stock: variant.stock,
    reservedStock: variant.reservedStock,
    costPrice: variant.costPrice === null ? null : Number(variant.costPrice),
    position: variant.position
  };
}

export function toAdminProduct(product, { includeVariants = true } = {}) {
  const base = toPublicProduct(product, { includeVariants: false });

  return {
    ...base,
    // El público solo ve el precio efectivo; el panel necesita los tres.
    basePrice: Number(product.basePrice),
    salePrice: product.salePrice === null ? null : Number(product.salePrice),
    currentPrice: Number(product.currentPrice),
    status: product.status,
    publishedAt: product.publishedAt,
    categoryId: product.categoryId,
    brandId: product.brandId,
    weightGrams: product.weightGrams,
    shortDescription: product.shortDescription,
    description: product.description,
    // El id de imagen SÍ va en el DTO de admin (nunca en el público): el
    // panel borra fotos por su id, y sin él no podría. Sobrescribe el mapa
    // público, que omite el id a propósito.
    images: product.images.map((image) => ({
      id: image.id,
      url: image.url,
      altText: image.altText ?? product.name,
      position: image.position
    })),
    ...(includeVariants
      ? {
          attributes: product.attributes.map((attribute) => ({
            name: attribute.attribute.name,
            slug: attribute.attribute.slug,
            value: attribute.value.label
          })),
          variants: product.variants.map(toAdminVariant)
        }
      : {})
  };
}

function dedupe(list) {
  return [...new Set(list)];
}