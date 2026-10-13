import { ApiResponse } from '../../utils/ApiResponse.js';
import { siteImageService } from './site-image.service.js';
import * as repository from './site-image.repository.js';
import { AppError } from '../../utils/AppError.js';
import { uploadSiteImageSchema, slotParamSchema } from './site-image.schema.js';

/**
 * Endpoints de las imágenes del escaparate: lectura pública y escritura
 * restringida a ADMIN/EDITOR.
 */
export const siteImageController = {
  /** Público: la portada pide aquí sus fotos. */
  async list(_req, res) {
    const data = await siteImageService.list();

    return ApiResponse.ok(res, { data });
  },

  /** Multipart: campo `image` + `slot` y `altText` como texto. */
  async upload(req, res) {
    const { slot, altText } = uploadSiteImageSchema.parse(req.body ?? {});
    const image = await siteImageService.upload(slot, req.file, { altText });

    return ApiResponse.created(res, image, 'Imagen del inicio actualizada');
  },

  async remove(req, res) {
    const { slot } = slotParamSchema.parse(req.params);
    await siteImageService.remove(slot);

    return ApiResponse.ok(res, { message: 'Imagen quitada: el hueco vuelve a su diseño de reserva' });
  },

  /**
   * Entrega el binario de una foto subida desde el panel. No usa ApiResponse
   * porque la respuesta NO es JSON: es la imagen.
   *
   * Las fotos del seed son URLs externas (sin binario): para esas se redirige
   * a la externa en lugar de devolver 404 a secas.
   */
  async serve(req, res) {
    const { slot } = req.validated.params;
    const image = await repository.findBySlot(slot);

    if (!image) throw AppError.notFound('Ese hueco no tiene imagen');

    if (image.data) {
      res.set({
        'Content-Type': image.mime ?? 'application/octet-stream',
        'Content-Length': String(image.data.length),
        // El binario NO es inmutable (reemplazar la foto conserva el slot),
        // así que se cachea poco: lo justo para no revalidar en cada scroll.
        'Cache-Control': 'public, max-age=300',
        'Content-Disposition': 'inline'
      });

      return res.end(Buffer.from(image.data));
    }

    return res.redirect(302, image.url);
  }
};
