# Retirada de Venus Points y Pass

**Estado (8 de noviembre de 2026): preparada; no aplicada en producción.**
La versión estable 4.6.2 todavía muestra Points y Pass. Aplicar la migración
supabase/migrations/0052_retire_points_pass.sql cuando la versión nueva
la haya reemplazado y se hayan comprobado los clientes activos.

La migración guarda el estado anterior del catálogo en la tabla privada
points_pass_retire_snapshot, desactiva los 80 artículos de tienda
y la temporada de Pass que están activos al revisar, pone a cero las
recompensas de puntos de 444 logros y retira el acceso de usuarios a las
nueve funciones de Points, tienda, Pass y regalos. Estos recuentos son
una fotografía de hoy y pueden cambiar antes de la activación.

No elimina saldos de usuarios, compras ni historial. La tabla privada de
respaldo conserva los valores anteriores de artículos, temporadas y logros
para una restauración revisada si hace falta. Tiene RLS activada y no concede
lectura a usuarios anónimos o autenticados.

Antes de aplicarla:

1. Confirmar que 4.6.2 fue reemplazada y que la nueva versión no muestra
   Points, Pass, tienda, marcos ni títulos de esa tienda.
2. Guardar un respaldo de la base de datos.
3. Volver a contar los artículos, temporadas y logros activos y verificar
   que existen las nueve funciones que la migración revoca.
4. Aplicar solo 0052 y comprobar que las cuentas conservan su saldo e historial.

La migración no forma parte de la beta 3 ni se ejecuta al instalar el launcher.
