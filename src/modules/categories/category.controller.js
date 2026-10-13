import { ApiResponse } from '../../utils/ApiResponse.js';
import { categoryService } from './category.service.js';
import {
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamSchema,
  reorderCategoriesSchema
} from './category.schema.js';

/**
 * Los middlewares ya han validado params/query; aquí solo queda validar el
 * cuerpo (distinto por endpoint) y formatear la respuesta.
 */
export const categoryController = {
  /** Público: categorías activas para filtros y pie. */
  async list(_req, res) {
    const data = await categoryService.list();

    return ApiResponse.ok(res, { data });
  },

  /** Panel: todas las categorías, incluidas desactivadas y vacías. */
  async listAll(_req, res) {
    const data = await categoryService.listAll();

    return ApiResponse.ok(res, { data });
  },

  async create(req, res) {
    const input = createCategorySchema.parse(req.body);
    const category = await categoryService.create(input);

    return ApiResponse.created(res, category, `Categoría "${category.name}" creada`);
  },

  async update(req, res) {
    const input = updateCategorySchema.parse(req.body);
    const { id } = categoryIdParamSchema.parse(req.params);
    const category = await categoryService.update(id, input);

    return ApiResponse.ok(res, { data: category, message: 'Categoría actualizada' });
  },

  async remove(req, res) {
    const { id } = categoryIdParamSchema.parse(req.params);
    await categoryService.remove(id);

    return ApiResponse.ok(res, { message: 'Categoría eliminada' });
  },

  async reorder(req, res) {
    const { ids } = reorderCategoriesSchema.parse(req.body);
    const data = await categoryService.reorder({ ids });

    return ApiResponse.ok(res, { data, message: 'Categorías reordenadas' });
  }
};
