# MenuBox

App web SPA (Angular 21 + Express + PostgreSQL) para planificación semanal de comidas, integrada con Thermomix (Cookidoo).

## Stack

| Capa | Tecnología |
|------|-----------|
| Frontend | Angular 21 (standalone components, TypeScript 5.9) |
| Build | @angular/build 21, Vitest para tests |
| Backend | Node.js + Express 4, puerto 3000 |
| BBDD | PostgreSQL, pool con `pg`, auto-init de tablas |
| Auth | JWT + bcryptjs |
| Despliegue | Docker + docker-compose, Nginx para frontend |

## Estructura

```
menubox/
├── src/                         # Frontend Angular
│   ├── main.ts                  # bootstrapApplication
│   ├── app/
│   │   ├── app.ts               # Componente raíz con sidebar, nav, menús
│   │   ├── app.html             # Layout: sidebar + router-outlet + bottom-nav
│   │   ├── app.config.ts        # Providers: router, http, auth interceptor
│   │   ├── app.routes.ts        # /login, /, /recipes, /settings
│   │   ├── models/              # Recipe, Ingredient interfaces
│   │   ├── services/
│   │   │   ├── auth.service.ts      # Login/register JWT, gestión menús, BehaviorSubjects
│   │   │   ├── auth.guard.ts        # CanActivate guard
│   │   │   ├── auth.interceptor.ts  # Añade token Bearer a peticiones
│   │   │   ├── menu.service.ts      # API calls: recipes, calendar, ingredients, settings
│   │   │   ├── thermomix.ts         # Integración Cookidoo (shopping list + agenda TM6)
│   │   │   ├── toast.service.ts     # Notificaciones toast
│   │   │   └── confirm.service.ts   # Modal de confirmación
│   │   └── components/
│   │       ├── calendar/            # Calendario mensual con generación automática
│   │       ├── recipe-manager/      # CRUD de recetas + búsqueda Cookidoo
│   │       ├── settings/            # Ajustes: credenciales Cookidoo y API keys de IA
│   │       ├── login/               # Login y registro
│   │       ├── toast-container/     # Contenedor de toasts
│   │       └── confirm-modal/       # Modal de confirmación
├── server/                      # Backend Express
│   ├── server.js                # API REST (761 líneas): auth, menus, recipes, calendar,
│   │                            #   ingredients/scrape,
│   │                            #   cookidoo (login, search, shopping list, agenda)
│   ├── database.js              # Pool PostgreSQL, init de tablas + admin por defecto
│   ├── schema.sql               # Esquema SQL de referencia
│   └── Dockerfile               # node:18-alpine
├── docs/                        # Documentación del proyecto
├── docker-compose.yml           # api (puerto 3000) + web (puerto 80)
├── docker-compose.prod.yml      # Imágenes Docker Hub
├── Dockerfile                   # Build Angular + Nginx multi-stage
└── nginx.conf                   # Servir SPA con fallback a index.html
```

## Base de datos (PostgreSQL, 6 tablas)

- `users` — username, email, password_hash
- `menus` — name, owner_id
- `user_menus` — user_id, menu_id, role
- `recipes` — name, type, slot (lunch|dinner|any), tags (csv), cookidooId, menu_id
- `recipe_ingredients` — recipe_id, name, category
- `calendar` — day, month, year, lunch_recipe_id, dinner_recipe_id, menu_id (UNIQUE día/mes/año/menú)
- `settings` — key, value, menu_id (PK compuesta)

Usuario por defecto: `admin` / `admin123`.

## API - Endpoints clave

| Método | Ruta | Auth |
|--------|------|------|
| POST | /api/auth/register | No |
| POST | /api/auth/login | No |
| GET | /api/recipes | Opcional (query menuId) |
| POST/PUT/DELETE | /api/recipes[/:id] | JWT |
| GET/POST | /api/calendar | Opcional / JWT |
| GET | /api/recipes/:id/ingredients | Opcional |
| POST | /api/recipes/:id/ingredients | JWT |
| GET | /api/recipes/:id/ingredients/scrape | JWT |
| POST | /api/cookidoo/login | No |
| GET | /api/cookidoo/search | No |
| POST | /api/cookidoo/add-to-shopping-list | No |
| POST | /api/cookidoo/add-to-calendar | No |
| GET/PUT | /api/settings | Opcional / JWT |

## Reglas de la pizarra (generación automática)

| Día | Comida | Cena |
|-----|--------|------|
| Lunes | legumbres | cena |
| Martes | verduras | cena |
| Miércoles | pescado | cena |
| Jueves | pasta | cena |
| Viernes | carne | libre |
| Sábado | libre | libre |
| Domingo | arroz/batch | cena |

## Despliegue en Render

- **render.yaml** con Web Service único (Node) + PostgreSQL
- El build compila Angular, la API sirve el frontend estático en producción
- Usa `DATABASE_URL` de Render, fallback a localhost:5432 en desarrollo
- `JWT_SECRET` generado automáticamente por Render

## Proxy de desarrollo

`proxy.conf.json` redirige `/api` a `localhost:3000` para `ng serve`.

## Convenios de código

- Sin comentarios en el código
- Tests con Vitest (`ng test`)
- Nomenclatura: `camelCase` en TS/JS, `snake_case` en SQL
- Componentes Angular standalone, sin NgModules
- URLs de API hardcodeadas a `http://localhost:3000/api`

## Comandos

```bash
npm start          # ng serve --port 5200
npm run build      # ng build (producción)
ng test            # Tests Vitest
cd server && npm start  # Arrancar API
docker-compose up  # Entorno completo
```
