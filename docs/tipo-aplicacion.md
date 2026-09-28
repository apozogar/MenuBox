# Tipo de Aplicación

**MenuBox** es una aplicación web **SPA (Single Page Application)** de planificación semanal de comidas, orientada a usuarios de **Thermomix**.

## Propósito

Generar y gestionar menús semanales de forma automática o manual, sincronizar las recetas con la lista de la compra de Cookidoo (Thermomix).

## Tecnologías Principales

| Capa | Tecnología |
|------|-----------|
| Frontend | **Angular 21** con componentes standalone |
| Lenguaje | **TypeScript 5.9** |
| Backend | **Node.js + Express 4** |
| Base de datos | **PostgreSQL** con `pg` (node-postgres) |
| Tests | **Vitest** + **jsdom** |
| Contenedores | **Docker** + **docker-compose** |
| Servidor web | **Nginx** (para producción) |

## Integraciones Externas

- **Cookidoo API** — Búsqueda de recetas, lista de la compra y agenda del Thermomix
