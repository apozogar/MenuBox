# Arquitectura del Sistema

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Navegador  │────▶│   Nginx      │────▶│  API Express │
│  (Angular)   │     │  (puerto 80) │     │  (puerto 3000)│
└──────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                                        ┌────────▼───────┐
                                        │   PostgreSQL   │
                                        │  (puerto 5432) │
                                        └────────────────┘
```

## Frontend (Angular 21)

- **Arquitectura**: Componentes standalone, bootstrap manual con `bootstrapApplication`
- **Enrutamiento**: `@angular/router` con 4 rutas:
  - `/login` — Login/Registro
  - `/` — Calendario (protegido)
  - `/recipes` — Gestor de recetas (protegido)
  - `/settings` — Ajustes (protegido)
- **Servicios principales**:
  - `AuthService` — Autenticación JWT, gestión de menús, estado de sesión
  - `MenuService` — API calls para recetas, calendario, ingredientes y ajustes
  - `Thermomix` — Integración con Cookidoo (lista de la compra y agenda)
  - `ToastService` / `ConfirmService` — Notificaciones y modales de confirmación
- **Interceptor HTTP**: `AuthInterceptor` — Añade el token JWT a todas las peticiones

## Backend (Node.js + Express)

- **Puerto**: 3000
- **Autenticación**: JWT con `bcryptjs` para hash de contraseñas
- **Endpoints**:
  - `POST /api/auth/register` — Registro de usuario
  - `POST /api/auth/login` — Inicio de sesión
  - `GET /api/auth/profile` — Perfil del usuario
  - `GET/POST/PUT/DELETE /api/menus` — CRUD de menús
  - `GET/POST/PUT/DELETE /api/recipes` — CRUD de recetas
  - `GET/POST /api/calendar` — Obtener/guardar calendario mensual
  - `GET/POST /api/recipes/:id/ingredients` — Ingredientes por receta
  - `GET /api/recipes/:id/ingredients/scrape` — Scraping desde Cookidoo
  - `GET /api/ingredients/from-calendar` — Ingredientes agregados del mes
  - `POST /api/cookidoo/login` — Login en Cookidoo
  - `GET /api/cookidoo/search` — Búsqueda de recetas en Cookidoo
  - `POST /api/cookidoo/add-to-shopping-list` — Añadir a lista de la compra
  - `POST /api/cookidoo/add-to-calendar` — Añadir a la agenda del Thermomix
  - `GET/PUT /api/settings` — Ajustes de la aplicación

## Base de Datos (PostgreSQL)

Esquema con 6 tablas principales:

- **users** — Usuarios del sistema
- **menus** — Menús (cada usuario puede tener varios)
- **user_menus** — Relación usuarios ↔ menús con roles
- **recipes** — Recetas con tipo, slot, tags y cookidooId
- **recipe_ingredients** — Ingredientes por receta
- **calendar** — Planificación día a día (comida y cena)
- **settings** — Configuración clave-valor por menú

### Inicialización

El fichero `server/database.js` crea las tablas automáticamente al arrancar y genera un usuario `admin` por defecto (`admin / admin123`).

## Despliegue

### Docker Compose (desarrollo)

```yaml
services:
  api:    # Construye server/Dockerfile, expone puerto 3000
  web:    # Construye Dockerfile (Angular build + Nginx), expone puerto 80
```

### Producción

- Imágenes publicadas en Docker Hub como `apozogar/menubox-api` y `apozogar/menubox-web`
- La API usa PostgreSQL directamente (localhost:5432)
- El frontend se sirve como contenido estático via Nginx
