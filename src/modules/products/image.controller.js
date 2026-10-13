import * as repository from './product.repository.js';
import { AppError } from '../../utils/AppError.js';

/**
 * Entrega el binario de una imagen guardada en MySQL.
 *
 * No usamos ApiResponse aquí porque la respuesta NO es JSON: es la foto. Este
 * es el único endpoint del proyecto que responde con algo que no sea
 * { success, data }, y por eso vive aislado en su propio controller.
 */
export const imageController = {
  async serve(req, res) {
    const { id } = req.validated.params;
    const image = await repository.findImageData(id);

    if (!image?.data) throw AppError.notFound('Imagen no encontrada');

    res.set({
      'Content-Type': image.mime ?? 'application/octet-stream',
      'Content-Length': String(image.data.length),
      // El contenido de una imagen con id UUID es inmutable: si el admin
      // reasigna la foto se crea otro id, así que podemos cachear un año.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Disposition': 'inline'
    });

    return res.end(Buffer.from(image.data));
  }
};