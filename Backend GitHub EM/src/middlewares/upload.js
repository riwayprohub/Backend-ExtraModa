import multer from 'multer';
import { AppError } from '../utils/AppError.js';
import { env } from '../config/env.js';

/**
 * Subida de imágenes de producto.
 *
 * El fichero se queda EN MEMORIA (multer.memoryStorage) y el service lo guarda en
 * MySQL. La versión anterior lo escribía en UPLOAD_DIR, lo cual no sobrevive a
 * un Render Free: ese disco se borra en cada reinicio y en cada despliegue, y
 * las fotos del catálogo desaparecerían al día siguiente.
 *
 * Reglas de seguridad (una imagen subida es un fichero que servimos a todo el
 * mundo, y a veces se acaba sirviendo a cualquiera):
 *
 *  1. Lista blanca de tipos MIME. Una lista negra es un agujero: alguien sube
 *     un .svg con JavaScript o un .php disfrazado.
 *  2. El nombre lo genera el servidor. Nunca usamos el nombre original: evita
 *     path traversal y colisiones.
 *  3. Tope de tamaño. Un PNG de 80 MB tumbaría el proceso: en memoria el
 *     fichero pasa entero por el heap antes de llegar a la base de datos.
 */

const MAX_SIZE_BYTES = env.MAX_UPLOAD_MB * 1024 * 1024;

export const ALLOWED_IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/avif', 'avif']
]);

export const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SIZE_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_IMAGE_TYPES.has(file.mimetype)) {
      return cb(
        AppError.badRequest(
          `Formato no permitido: ${file.mimetype}. Se aceptan JPEG, PNG, WebP y AVIF.`
        )
      );
    }
    cb(null, true);
  }
}).single('image');

/**
 * Convierte los errores de multer al formato de la API.
 * Sin esto, un fichero demasiado grande devolvería un 500 con HTML.
 */
export function handleUpload(req, res, next) {
  uploadProductImage(req, res, (error) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          return next(
            AppError.badRequest(`La imagen supera el máximo de ${env.MAX_UPLOAD_MB} MB`)
          );
        }
        return next(AppError.badRequest(`Error de subida: ${error.message}`));
      }
      return next(error);
    }

    next();
  });
}

export { MAX_SIZE_BYTES };