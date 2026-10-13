-- current_price = COALESCE(sale_price, base_price), desnormalizado.
--
-- Motivo: MySQL ordena los NULL por delante de los valores, así que
-- ORDER BY sale_price mezclaba productos con y sin oferta. Además, un filtro de
-- rango sobre COALESCE(sale_price, base_price) no puede usar ningún índice;
-- con una columna real sí.

-- 1) Columna nullable: permite añadirla a una tabla con filas existentes
ALTER TABLE `products` ADD COLUMN `current_price` DECIMAL(10, 2) NULL;

-- 2) Backfill de los datos actuales
UPDATE `products` SET `current_price` = COALESCE(`sale_price`, `base_price`);

-- 3) A partir de aquí es obligatoria
ALTER TABLE `products` MODIFY COLUMN `current_price` DECIMAL(10, 2) NOT NULL;

-- 4) Índice para filtrar por rango de precio y ordenar por precio
CREATE INDEX `products_current_price_idx` ON `products` (`current_price`);