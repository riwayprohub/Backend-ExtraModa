import { Router } from 'express';
import { env } from '../../config/env.js';
import { checkDatabase } from '../../config/database.js';
import { ApiResponse } from '../../utils/ApiResponse.js';

const router = Router();

/**
 * GET /api/v1/health
 * Sonda de vida para Docker/Kubernetes y para saber si la BD responde.
 * 200 si todo va bien, 503 si la base de datos está caída.
 */
router.get('/', async (req, res) => {
  let database;
  try {
    database = await checkDatabase();
  } catch (error) {
    return ApiResponse.error(res, {
      statusCode: 503,
      code: 'DATABASE_DOWN',
      message: 'La base de datos no responde'
    });
  }

  ApiResponse.ok(res, {
    data: {
      status: 'ok',
      service: 'extramoda-api',
      environment: env.NODE_ENV,
      version: process.env.npm_package_version ?? '1.0.0',
      uptimeSeconds: Math.round(process.uptime()),
      database
    }
  });
});

export { router as healthRoutes };