import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Los tests corren contra el MySQL real de desarrollo, no contra una base
    // desechable por archivo. En paralelo, varios archivos tocaban a la vez las
    // mismas filas reales (usuarios del seed al hacer login, cupones al
    // consumir, stock de las variantes) y se bloqueaban entre sí: una vez la
    // suite completa se quedó esperando locks hasta agotar el timeout.
    // Serializando los archivos, cada uno deja la base como la encontró.
    fileParallelism: false,

    // Los tests de integración dan de sí a MySQL; 5 s se quedaba corto cuando
    // la máquina compite con otras cosas.
    testTimeout: 20000,
    hookTimeout: 20000
  }
});
