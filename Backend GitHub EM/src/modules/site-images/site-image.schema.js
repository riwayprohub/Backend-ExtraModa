import { z } from 'zod';

/**
 * Validaciones de las imágenes del escaparate de inicio.
 *
 * La lista de huecos (`slot`) es CERRADA a propósito: son sitios concretos de
 * la portada, no un almacén de fotos. Si mañana la portada gana un hueco, se
 * añade aquí y el panel lo ofrece solo; un slot inventado desde fuera daría
 * una imagen que nadie muestra.
 */

export const SITE_IMAGE_SLOTS = [
  'hero-1',
  'hero-2',
  'category-accesorios',
  'category-abrigos',
  'category-blusas',
  'category-calzados',
  'category-faldas',
  'category-jeans',
  'category-remeras',
  'category-shorts',
  'category-sweater',
  'category-vestidos'
];

const slot = z.enum(SITE_IMAGE_SLOTS);

export const slotParamSchema = z.object({
  slot
});

/** Multipart: `image` (fichero) + `slot` y `altText` como campos de texto. */
export const uploadSiteImageSchema = z.object({
  slot,
  altText: z.string().trim().max(160).optional()
});
