import crypto from 'node:crypto';
import { AppError } from '../../utils/AppError.js';
import * as repository from './site-image.repository.js';

/**
 * Reglas de las imágenes del escaparate.
 *
 * No conoce req/res: recibe datos ya validados y devuelve DTOs.
 */

export const siteImageService = {
  /** Listado público: lo consume la portada para pintar sus fotos. */
  async list() {
    const images = await repository.findAll();

    // Devuelvo también los huecos VACÍOS: así la portada distingue "esta foto
    // no se ha subido" de "no hay fotos", y puede mantener su diseño de
    // reserva en lugar de enseñar un agujero.
    return images.map((image) => ({
      slot: image.slot,
      url: image.url,
      altText: image.altText,
      uploaded: Boolean(image.bytes), // false = foto externa del seed
      updatedAt: image.updatedAt
    }));
  },

  async upload(slot, file, { altText }) {
    if (!file) throw AppError.badRequest('No se ha recibido ningún archivo (campo "image")');

    // Id propio para poder escribir la URL pública en la misma instrucción.
    const id = crypto.randomUUID();

    const image = await repository.replaceSlot({
      id,
      slot,
      url: `/api/v1/site-images/${slot}`,
      altText,
      data: file.buffer,
      mime: file.mimetype,
      bytes: file.size
    });

    return image;
  },

  async remove(slot) {
    const existing = await repository.findBySlot(slot);
    if (!existing) throw AppError.notFound('Ese hueco no tiene imagen');

    await repository.remove(slot);
    return { slot };
  }
};
