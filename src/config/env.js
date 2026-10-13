import 'dotenv/config';
import { z } from 'zod';

const isProd = process.env.NODE_ENV === 'production';

/**
 * Fail-fast: si una variable crítica falta o es inválida, el proceso muere AQUÍ,
 * al arrancar, en lugar de fallar en producción con un error 500 a las 3 AM.
 *
 * Regla: en desarrollo permitimos valores por defecto para no bloquear al equipo;
 * en producción los secretos son obligatorios y con longitud mínima.
 */
const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatoria (mira .env.example)'),

    JWT_SECRET: z.string().min(32, 'JWT_SECRET debe tener al menos 32 caracteres'),
    JWT_EXPIRES_IN: z.string().default('15m'),
    REFRESH_TOKEN_SECRET: z.string().min(32),
    REFRESH_TOKEN_EXPIRES_IN: z.string().default('7d'),

    CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN es obligatoria'),

    /**
     * Carpeta de imágenes en el disco. Solo se usa en desarrollo: en Render el
     * disco se borra en cada reinicio, así que las subidas van a MySQL
     * (ver src/modules/products/image.controller.js).
     */
    UPLOAD_DIR: z.string().min(1).default('uploads/productos'),

    /** Tope de tamaño de la imagen en MB. */
    MAX_UPLOAD_MB: z.coerce.number().int().positive().max(20).default(2),

    /**
     * Reintentos de conexión al arrancar. El MySQL de Aiven en plan gratuito se
     * APAGA solo tras un rato sin uso: sin reintentos, el proceso moriría en el
     * primer arranque tras una noche sin visitas y Render lo reiniciaría en
     * bucle.
     */
    DB_CONNECT_RETRIES: z.coerce.number().int().min(0).max(10).default(4),
    DB_CONNECT_RETRY_MS: z.coerce.number().int().min(200).max(30_000).default(3000),

    /** Sirve el build del frontend (frontend/dist) desde el mismo servicio. */
    SERVE_SPA: z
      .string()
      .optional()
      .transform((value) => (value === undefined ? isProd : value === 'true')),

    /** Ejecuta prisma/seed.js al arrancar si la tabla de productos está vacía. */
    SEED_ON_BOOT: z
      .string()
      .optional()
      .transform((value) => value === 'true'),

    /** Muestra cada query SQL en consola (depuración). */
    LOG_QUERIES: z
      .string()
      .optional()
      .transform((value) => value === 'true'),

    // Stripe es OPCIONAL: el checkout registra el pedido como PENDING y la
    // confirmación es manual. Exigirlo en producción impedía desplegar sin una
    // cuenta de pago, que es justo el escenario gratuito que queremos cubrir.
    STRIPE_SECRET_KEY: z.string().optional(),
    STRIPE_WEBHOOK_SECRET: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    // En dev rellenamos con valores de mentira; en prod, nunca.
    if (!isProd && !value.JWT_SECRET) {
      value.JWT_SECRET = 'dev_secret_no_usar_en_produccion_0123456789abcdef';
      value.REFRESH_TOKEN_SECRET = 'dev_refresh_secret_no_usar_en_produccion_0123456789';
    }
    if (!isProd && !value.CORS_ORIGIN) value.CORS_ORIGIN = 'http://localhost:5173';

    // En producción el frontend y la API comparten dominio (un único servicio
    // Render), así que el único origen permitido es él mismo. Sin CORS_ORIGIN lo
    // asumimos en vez de inventar uno: un allowlist equivocado deja el sitio
    // entero sin poder llamar a la API desde el navegador.
    if (isProd && value.CORS_ORIGIN.includes('localhost')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGIN'],
        message: 'En producción CORS_ORIGIN debe ser tu dominio real, no localhost'
      });
    }
  });

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('\n✖ Configuración de entorno inválida:\n');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.') || '(raíz)'}: ${issue.message}`);
  }
  console.error('\nRevisa tu archivo .env (plantilla en .env.example)\n');
  process.exit(1);
}

const values = parsed.data;

export const env = Object.freeze({
  ...values,
  isProd,
  /** Orígenes permitidos en CORS, ya en array: "a.com,b.com" -> ['a.com','b.com'] */
  corsOrigins: values.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
});

export const NODE_ENV = env.NODE_ENV;
export const PORT = env.PORT;
export const DATABASE_URL = env.DATABASE_URL;
export const CORS_ORIGINS = env.corsOrigins;