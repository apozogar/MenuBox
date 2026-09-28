# Objetivos del Proyecto

## Objetivo Principal

Automatizar la planificación semanal de comidas siguiendo una **pizarra de tipos de plato** (legumbres, verduras, pescado, pasta, carne, cena, arroz) y minimizar el tiempo dedicado a crear la lista de la compra.

## Reglas de la Pizarra (Planificación Semanal)

| Día | Comida | Cena |
|-----|--------|------|
| Lunes | legumbres | cena |
| Martes | verduras | cena |
| Miércoles | pescado | cena |
| Jueves | pasta | cena |
| Viernes | carne | libre |
| Sábado | libre | libre |
| Domingo | arroz / batch cooking | cena |

## Funcionalidades Actuales

1. **Autenticación** — Registro e inicio de sesión con JWT
2. **Gestión de Menús** — Crear, renombrar, eliminar y seleccionar múltiples menús
3. **Gestión de Recetas** — CRUD completo con nombre, tipo, slot, tags y Cookidoo ID
4. **Planificación Automática** — Generación aleatoria del calendario mensual siguiendo las reglas de pizarra, evitando repetir recetas del mismo tipo
5. **Edición Manual** — Pinchar en un día para cambiar la receta de comida o cena
6. **Sincronización con Thermomix** — Añadir recetas a la lista de la compra y a la agenda de Cookidoo
7. **Scraping de Ingredientes** — Extraer ingredientes desde la web de Cookidoo
8. **Guardar Ajustes** — Credenciales de Cookidoo y API keys de IA persistentes en la BBDD

## Hoja de Ruta / Posibles Mejoras

- Sugerir cantidades según número de comensales
- Vista de lista de la compra agregada por categoría
- Importación/exportación de recetas
- Compartir menús entre usuarios
- Notificaciones / recordatorios
