import { AppError } from '../utils/AppError.js';

/**
 * Valida body / query / params contra schemas de Zod y deja el resultado
 * tipado y limpio en `req.validated`.
 *
 *   router.post('/', validate({ body: createSchema }), controller.create)
 *   const { name } = req.validated.body;   // ya parseado y con tipos correctos
 *
 * Express 5 propaga automáticamente los rechazos de promesas, así que un
 * `throw` dentro de un handler async llega solo hasta errorHandler.
 */
export function validate(schemas) {
  return (req, _res, next) => {
    req.validated = req.validated ?? {};

    for (const source of ['params', 'query', 'body']) {
      const schema = schemas[source];
      if (!schema) continue;

      const result = schema.safeParse(req[source]);

      if (!result.success) {
        const errors = {};
        for (const issue of result.error.issues) {
          const field = issue.path.join('.') || source;
          // Conserva el primer error por campo: es lo que muestra el formulario
          errors[field] ??= issue.message;
        }
        return next(AppError.unprocessable('Los datos enviados no son válidos', errors));
      }

      req.validated[source] = result.data;
    }

    next();
  };
}