import { z } from 'zod';

/**
 * Política de contraseñas: longitud mínima (lo que más importa, según NIST)
 * + verificación contra las listas de contraseñas más filtradas.
 * No obligamos a símbolos: empujar a la gente a escribir "Password1!"
 * produce contraseñas peores, no mejores.
 */
const passwordSchema = z
  .string()
  .min(8, 'La contraseña debe tener al menos 8 caracteres')
  .max(72, 'La contraseña no puede superar 72 caracteres') // límite de bcrypt
  .refine((value) => /[a-záéíóúñ]/i.test(value), {
    message: 'La contraseña debe incluir al menos una letra'
  })
  .refine((value) => /\d/.test(value), { message: 'La contraseña debe incluir al menos un número' });

const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .email('Introduce un email válido')
  .max(191);

export const registerSchema = z.object({
  firstName: z.string().trim().min(2, 'El nombre debe tener al menos 2 caracteres').max(80),
  lastName: z.string().trim().min(2, 'Los apellidos deben tener al menos 2 caracteres').max(80),
  email: emailSchema,
  password: passwordSchema,
  phone: z.string().trim().min(6).max(30).optional()
  // Nota: NO se declara `role`. Zod descarta las claves no declaradas, así que
  // un `{"role":"ADMIN"}` se ignora en silencio (y `createUser` fuerza
  // CUSTOMER). Declararlo con z.never() daría un 422 críptico al cliente.
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'La contraseña es obligatoria').max(72)
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(10).optional() // si no, se toma de la cookie
});

export const sessionParamsSchema = z.object({
  id: z.string().min(1).max(64)
});

export const updateProfileSchema = z
  .object({
    firstName: z.string().trim().min(2).max(80),
    lastName: z.string().trim().min(2).max(80),
    phone: z.string().trim().min(6).max(30).nullable()
  })
  .partial()
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Envía al menos un campo para actualizar'
  });

export const listUsersQuerySchema = z.object({
  page: z.coerce.number().int().min(1, 'La página empieza en 1').default(1),
  perPage: z.coerce.number().int().min(1).max(100).default(25),
  role: z.enum(['CUSTOMER', 'ADMIN', 'EDITOR']).optional(),
  q: z.string().trim().max(120).optional()
});