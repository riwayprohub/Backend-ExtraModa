/**
 * Contrato de respuesta ÚNICO para toda la API.
 * El frontend tiene una sola forma de leer éxito y error.
 */
export class ApiResponse {
  static ok(res, { data = null, meta, message } = {}, statusCode = 200) {
    return res.status(statusCode).json({
      success: true,
      ...(message && { message }),
      data,
      ...(meta && { meta })
    });
  }

  static created(res, data, message) {
    return ApiResponse.ok(res, { data, message }, 201);
  }

  static noContent(res) {
    return res.status(204).end();
  }

  static paginated(res, { items, total, page, perPage }) {
    return res.status(200).json({
      success: true,
      data: items,
      meta: {
        total,
        page,
        perPage,
        totalPages: Math.max(1, Math.ceil(total / perPage)),
        hasNextPage: page * perPage < total,
        hasPrevPage: page > 1
      }
    });
  }

  static error(res, { statusCode = 500, code = 'INTERNAL_ERROR', message, details }) {
    return res.status(statusCode).json({
      success: false,
      code,
      message,
      ...(details && { errors: details })
    });
  }
}