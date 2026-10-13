-- Idempotencia del checkout: una misma clave por usuario no puede crear dos
-- pedidos. La columna admite NULL para los pedidos ya existentes y para los
-- clientes que no envían la cabecera; MySQL permite varias filas con NULL en un
-- índice único, así que la restricción solo afecta a los checkouts que sí la
-- mandan.
ALTER TABLE `orders` ADD COLUMN `idempotency_key` VARCHAR(64) NULL;

CREATE UNIQUE INDEX `orders_user_id_idempotency_key_key` ON `orders`(`user_id`, `idempotency_key`);