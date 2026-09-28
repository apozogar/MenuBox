const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z } = require('zod');
const { query } = require('./database');
const db = require('./database');
const JWT_SECRET = db.JWT_SECRET || process.env.JWT_SECRET || 'change-me';

const app = express();
const port = 3000;

app.set('trust proxy', 1);

// Load seed recipes (safe fallback if file missing)
let seedRecipes = [];
try {
  const seedPath = path.join(__dirname, 'sql', 'recetas_base.json');
  if (fs.existsSync(seedPath)) {
    seedRecipes = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    console.log('Seed recipes loaded:', seedRecipes.length);
  } else {
    console.log('No seed file found at', seedPath);
  }
} catch (e) {
  console.error('Error loading seed recipes:', e.message);
}

async function seedRecipesForMenu(menuId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const r of seedRecipes) {
      await client.query(
        "INSERT INTO recipes (name, type, slot, tags, cookidooId, menu_id) VALUES ($1, $2, $3, $4, $5, $6)",
        [r.name, r.type, r.slot, r.tags, r.cookidooId, menuId]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('Error seeding recipes for menu', menuId, e.message);
  } finally {
    client.release();
  }
}

app.use(cors());
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos, espera 15 minutos.' },
});

app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// === VALIDATION SCHEMAS ===
const registerSchema = z.object({
  username: z.string().min(3).max(30),
  email: z.string().email(),
  password: z.string().min(6).max(100),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const recipeSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.string().min(1),
  slot: z.enum(['lunch', 'dinner', 'any']),
  tags: z.array(z.string()).optional().default([]),
  cookidooId: z.string().optional().default(''),
  servings: z.number().int().min(1).max(50).optional().default(4),
  image_url: z.string().optional().default(''),
  menuId: z.number().optional(),
});

const menuSchema = z.object({
  name: z.string().min(1).max(100),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(6).max(100),
});

function validate(schema, data) {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { error: errors };
  }
  return { data: result.data };
}

// === AUTH MIDDLEWARE ===
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }
  try {
    const token = header.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.split(' ')[1], JWT_SECRET);
    } catch {}
  }
  next();
}

// === AUTH ENDPOINTS ===
app.post('/api/auth/register', async (req, res) => {
  const result = validate(registerSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { username, email, password } = result.data;
  try {
    const hash = bcrypt.hashSync(password, 10);
    const userResult = await query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      [username, email, hash]
    );
    const userId = userResult.rows[0].id;

    const menuResult = await query(
      "INSERT INTO menus (name, owner_id) VALUES ($1, $2) RETURNING id",
      ['Mi Menú', userId]
    );
    const menuId = menuResult.rows[0].id;
    await query(
      "INSERT INTO user_menus (user_id, menu_id, role) VALUES ($1, $2, $3)",
      [userId, menuId, 'admin']
    );

    seedRecipesForMenu(menuId);

    const token = jwt.sign({ userId, username, email }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: { id: userId, username, email }, menuId });
  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ error: 'El usuario o email ya existe' });
    }
    res.status(500).json({ error: e.message });
  }
});

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.ip || '';
}

async function logLoginAttempt({ userId, username, success, req }) {
  try {
    await query(
      "INSERT INTO login_history (user_id, username, success, ip, user_agent) VALUES ($1, $2, $3, $4, $5)",
      [userId || null, username, success, getClientIp(req), req.headers['user-agent'] || '']
    );
  } catch (e) {
    console.error('Error registrando historial de acceso:', e.message);
  }
}

app.post('/api/auth/login', async (req, res) => {
  const result = validate(loginSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { username, password } = result.data;
  try {
    const { rows } = await query(
      "SELECT id, username, email, password_hash, is_superadmin FROM users WHERE username = $1 OR email = $1",
      [username]
    );
    if (rows.length === 0) {
      await logLoginAttempt({ userId: null, username, success: false, req });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    const row = rows[0];
    if (!bcrypt.compareSync(password, row.password_hash)) {
      await logLoginAttempt({ userId: row.id, username: row.username, success: false, req });
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    await logLoginAttempt({ userId: row.id, username: row.username, success: true, req });
    const token = jwt.sign(
      { userId: row.id, username: row.username, email: row.email },
      JWT_SECRET,
      { expiresIn: '30d' },
    );
    res.json({
      token,
      user: { id: row.id, username: row.username, email: row.email, isSuperadmin: row.is_superadmin },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/profile', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, username, email, created_at, is_superadmin AS \"isSuperadmin\" FROM users WHERE id = $1",
      [req.user.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function superadminMiddleware(req, res, next) {
  try {
    const { rows } = await query("SELECT is_superadmin FROM users WHERE id = $1", [req.user.userId]);
    if (rows.length === 0 || !rows[0].is_superadmin) {
      return res.status(403).json({ error: 'Acceso restringido a superadministradores' });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get('/api/admin/login-history', authMiddleware, superadminMiddleware, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);
    const usernameFilter = (req.query.username || '').trim();

    const params = [];
    let where = '';
    if (usernameFilter) {
      params.push(`%${usernameFilter}%`);
      where = `WHERE lh.username ILIKE $${params.length}`;
    }

    params.push(limit, offset);
    const { rows } = await query(
      `SELECT lh.id, lh.user_id, lh.username, lh.success, lh.ip, lh.user_agent, lh.created_at, u.email
       FROM login_history lh
       LEFT JOIN users u ON u.id = lh.user_id
       ${where}
       ORDER BY lh.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const countParams = usernameFilter ? [`%${usernameFilter}%`] : [];
    const countWhere = usernameFilter ? 'WHERE username ILIKE $1' : '';
    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM login_history ${countWhere}`,
      countParams
    );

    res.json({ entries: rows, total: parseInt(countRows[0].count) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/auth/change-password', authMiddleware, async (req, res) => {
  const result = validate(changePasswordSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { currentPassword, newPassword } = result.data;
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: 'La nueva contraseña debe ser diferente' });
  }
  try {
    const { rows } = await query(
      "SELECT password_hash FROM users WHERE id = $1",
      [req.user.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!bcrypt.compareSync(currentPassword, rows[0].password_hash)) {
      return res.status(401).json({ error: 'Contraseña actual incorrecta' });
    }
    const hash = bcrypt.hashSync(newPassword, 10);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, req.user.userId]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === MENUS ===
app.get('/api/menus', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT m.*, um.role FROM menus m
       JOIN user_menus um ON um.menu_id = m.id
       WHERE um.user_id = $1
       ORDER BY m.name`,
      [req.user.userId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menus', authMiddleware, async (req, res) => {
  const result = validate(menuSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { name } = result.data;
  try {
    const { rows } = await query(
      "INSERT INTO menus (name, owner_id) VALUES ($1, $2) RETURNING id",
      [name, req.user.userId]
    );
    const menuId = rows[0].id;
    await query(
      "INSERT INTO user_menus (user_id, menu_id, role) VALUES ($1, $2, $3)",
      [req.user.userId, menuId, 'admin']
    );
    seedRecipesForMenu(menuId);
    res.json({ id: menuId, name, owner_id: req.user.userId });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/menus/:id', authMiddleware, async (req, res) => {
  const { name } = req.body;
  try {
    const result = await query(
      "UPDATE menus SET name = $1 WHERE id = $2 AND owner_id = $3",
      [name, req.params.id, req.user.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Menú no encontrado' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menus/:id', authMiddleware, async (req, res) => {
  try {
    const result = await query(
      "DELETE FROM menus WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.user.userId]
    );
    if (result.rowCount === 0) return res.status(404).json({ error: 'Menú no encontrado' });
    await query("DELETE FROM user_menus WHERE menu_id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/menus/:id/users', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.username, u.email, um.role
       FROM user_menus um JOIN users u ON u.id = um.user_id
       WHERE um.menu_id = $1 ORDER BY um.role, u.username`,
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menus/:id/share', authMiddleware, async (req, res) => {
  const { usernameOrEmail, role } = req.body;
  if (!usernameOrEmail) return res.status(400).json({ error: 'usernameOrEmail requerido' });
  try {
    const ownerCheck = await query(
      "SELECT id FROM menus WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.user.userId]
    );
    if (ownerCheck.rowCount === 0) return res.status(403).json({ error: 'Solo el dueño puede compartir' });

    const userRes = await query(
      "SELECT id FROM users WHERE username = $1 OR email = $1",
      [usernameOrEmail]
    );
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });

    const targetId = userRes.rows[0].id;
    if (targetId === req.user.userId) return res.status(400).json({ error: 'No puedes compartir contigo mismo' });

    await query(
      `INSERT INTO user_menus (user_id, menu_id, role) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, menu_id) DO UPDATE SET role = $3`,
      [targetId, req.params.id, role || 'editor']
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/menus/:id/users/:userId', authMiddleware, async (req, res) => {
  try {
    const ownerCheck = await query(
      "SELECT id FROM menus WHERE id = $1 AND owner_id = $2",
      [req.params.id, req.user.userId]
    );
    if (ownerCheck.rowCount === 0) return res.status(403).json({ error: 'Solo el dueño puede gestionar usuarios' });

    await query(
      "DELETE FROM user_menus WHERE menu_id = $1 AND user_id = $2",
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/menus/:id/clone', authMiddleware, async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: srcMenus } = await client.query("SELECT * FROM menus WHERE id = $1", [req.params.id]);
    if (srcMenus.length === 0) return res.status(404).json({ error: 'Menú no encontrado' });

    const src = srcMenus[0];
    const newName = req.body.name || (src.name + ' (copia)');

    const { rows: newMenu } = await client.query(
      "INSERT INTO menus (name, owner_id) VALUES ($1, $2) RETURNING id",
      [newName, req.user.userId]
    );
    const newMenuId = newMenu[0].id;

    await client.query(
      "INSERT INTO user_menus (user_id, menu_id, role) VALUES ($1, $2, 'admin')",
      [req.user.userId, newMenuId]
    );

    const { rows: srcRecipes } = await client.query("SELECT * FROM recipes WHERE menu_id = $1", [req.params.id]);
    for (const r of srcRecipes) {
      const { rows: newRecipe } = await client.query(
        "INSERT INTO recipes (name, type, slot, tags, cookidooId, servings, image_url, menu_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        [r.name, r.type, r.slot, r.tags, r.cookidooid || '', r.servings || 4, r.image_url || '', newMenuId]
      );
      const { rows: ingredients } = await client.query("SELECT * FROM recipe_ingredients WHERE recipe_id = $1", [r.id]);
      for (const ing of ingredients) {
        await client.query(
          "INSERT INTO recipe_ingredients (recipe_id, name, category, quantity, unit) VALUES ($1, $2, $3, $4, $5)",
          [newRecipe[0].id, ing.name, ing.category, ing.quantity, ing.unit]
        );
      }
    }

    const { rows: srcCalendar } = await client.query("SELECT * FROM calendar WHERE menu_id = $1", [req.params.id]);
    for (const c of srcCalendar) {
      await client.query(
        `INSERT INTO calendar (day, month, year, lunch_recipe_id, dinner_recipe_id, menu_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [c.day, c.month, c.year, c.lunch_recipe_id, c.dinner_recipe_id, newMenuId]
      );
    }

    await client.query('COMMIT');
    res.json({ id: newMenuId, name: newName });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

async function getMenuIds(userId) {
  const { rows } = await query(
    "SELECT menu_id FROM user_menus WHERE user_id = $1",
    [userId]
  );
  return rows.map(r => r.menu_id);
}

// Obtener todas las recetas
app.get('/api/recipes', optionalAuth, async (req, res) => {
  const menuId = parseInt(req.query.menuId) || 1;
  try {
    if (req.user) {
      const ids = await getMenuIds(req.user.userId);
      if (!ids.includes(menuId)) {
        return res.status(403).json({ error: 'No tienes acceso a este menú' });
      }
    }
    const { rows } = await query(
      "SELECT * FROM recipes WHERE menu_id = $1 ORDER BY name",
      [menuId]
    );
    const recipes = rows.map(r => ({ ...r, tags: r.tags ? r.tags.split(',') : [], cookidooId: r.cookidooid || '' }));
    res.json(recipes);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Crear una receta
app.post('/api/recipes', authMiddleware, async (req, res) => {
  const result = validate(recipeSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { name, type, slot, tags, cookidooId, servings, image_url } = result.data;
  const menuId = req.body.menuId || parseInt(req.query.menuId) || 1;
  try {
    if (cookidooId) {
      const { rows: existing } = await query(
        "SELECT id FROM recipes WHERE cookidooId = $1 AND menu_id = $2",
        [cookidooId, menuId]
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'Esta receta ya está importada en este menú', id: existing[0].id });
      }
    }
    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const { rows } = await query(
      "INSERT INTO recipes (name, type, slot, tags, cookidooId, servings, image_url, menu_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
      [name, type, slot, tagsStr, cookidooId || '', servings, image_url || '', menuId]
    );
    res.json({ id: rows[0].id, name, type, slot, tags: tagsStr ? tagsStr.split(',') : [], cookidooId, servings, image_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Actualizar una receta
app.put('/api/recipes/:id', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const result = validate(recipeSchema, req.body);
  if (result.error) return res.status(400).json({ error: result.error });
  const { name, type, slot, tags, cookidooId, servings, image_url } = result.data;
  try {
    const tagsStr = Array.isArray(tags) ? tags.join(',') : (tags || '');
    const updResult = await query(
      "UPDATE recipes SET name = $1, type = $2, slot = $3, tags = $4, cookidooId = $5, servings = $6, image_url = $7 WHERE id = $8",
      [name, type, slot, tagsStr, cookidooId || '', servings, image_url || '', id]
    );
    if (updResult.rowCount === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json({ id: Number(id), name, type, slot, tags: tagsStr ? tagsStr.split(',') : [], cookidooId, servings, image_url });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Eliminar una receta
app.delete('/api/recipes/:id', authMiddleware, async (req, res) => {
  try {
    const result = await query("DELETE FROM recipes WHERE id = $1", [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    res.json({ message: 'Receta eliminada' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener calendario de un mes/año
app.get('/api/calendar', optionalAuth, async (req, res) => {
  const { month, year } = req.query;
  const menuId = parseInt(req.query.menuId) || 1;
  try {
    if (req.user) {
      const ids = await getMenuIds(req.user.userId);
      if (!ids.includes(menuId)) {
        return res.status(403).json({ error: 'No tienes acceso a este menú' });
      }
    }
    const { rows } = await query(
      "SELECT * FROM calendar WHERE month = $1 AND year = $2 AND menu_id = $3",
      [month, year, menuId]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar calendario (recibe un array de días)
app.post('/api/calendar', authMiddleware, async (req, res) => {
  const days = req.body;
  const menuId = req.query.menuId || 1;
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const d of days) {
      if (d.day) {
        await client.query(
          `INSERT INTO calendar (day, month, year, lunch_recipe_id, dinner_recipe_id, menu_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (day, month, year, menu_id) DO UPDATE SET
             lunch_recipe_id = EXCLUDED.lunch_recipe_id,
             dinner_recipe_id = EXCLUDED.dinner_recipe_id`,
          [d.day, d.month, d.year, d.lunchId, d.dinnerId, menuId]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ message: "Calendario guardado" });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// === GENERACIÓN IA (Gemini) ===

app.post('/api/menu/generate-ai', authMiddleware, async (req, res) => {
  const { month, year, startDay } = req.body;
  const menuId = parseInt(req.query.menuId) || 1;

  if (month == null || year == null) {
    return res.status(400).json({ error: 'Faltan month y year' });
  }

  try {
    const settings = await getSettings(menuId, ['gemini_api_key', 'groq_api_key']);
    const geminiKey = cleanApiKey(settings.gemini_api_key);
    const groqKey = cleanApiKey(settings.groq_api_key);

    if (!geminiKey && !groqKey) {
      return res.status(400).json({ error: 'Configura al menos una API Key de IA en Ajustes (Gemini o Groq)' });
    }

    const { rows: recipes } = await query(
      "SELECT id, name, type, slot, tags FROM recipes WHERE menu_id = $1 ORDER BY type, name",
      [menuId]
    );

    if (recipes.length === 0) {
      return res.status(400).json({ error: 'No hay recetas en este menú. Crea algunas primero.' });
    }

    // Group recipes by type for compact prompt (saves tokens)
    const recipesByType = new Map();
    for (const r of recipes) {
      if (!recipesByType.has(r.type)) recipesByType.set(r.type, []);
      recipesByType.get(r.type).push(r.id);
    }
    let recipesList = '';
    for (const [type, ids] of recipesByType) {
      recipesList += `${type}: ${ids.join(',')}\n`;
    }
    recipesList = recipesList.trim();

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstDay = startDay || 1;
    const monthNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const dayAbbr = ['Dom','Lun','Mar','Mie','Jue','Vie','Sab'];
    const dayRulesDefault = {
      0: { lunch: 'arroz', dinner: 'cena' },
      1: { lunch: 'legumbres', dinner: 'cena' },
      2: { lunch: 'verduras', dinner: 'cena' },
      3: { lunch: 'pescado', dinner: 'cena' },
      4: { lunch: 'pasta', dinner: 'cena' },
      5: { lunch: 'carne', dinner: 'free' },
      6: { lunch: 'free', dinner: 'free' },
    };
    let dayRules;
    const { rows: ruleRows } = await query(
      "SELECT value FROM settings WHERE key = 'board_rules' AND menu_id = $1",
      [menuId]
    );
    if (ruleRows.length > 0) {
      try {
        dayRules = JSON.parse(ruleRows[0].value);
      } catch { dayRules = null; }
    }
    if (!dayRules) dayRules = dayRulesDefault;

    let calendarRules = '';
    for (let d = firstDay; d <= daysInMonth; d++) {
      const dow = new Date(year, month, d).getDay();
      const rule = dayRules[dow] || dayRulesDefault[dow];
      calendarRules += `${d}=${dayAbbr[dow]}(${rule.lunch}/${rule.dinner}) `;
    }

    const prompt = `Eres nutricionista. Genera menú equilibrado para ${monthNames[month]} (días ${firstDay}-${daysInMonth}).

Cada día tiene una regla fija de tipo de plato. El tipo va ANTES de la barra para almuerzo, DESPUÉS para cena:
${calendarRules}

Recetas: ${recipesList}
IDs especiales: -1=libre, -2=arroz domingo, -3=improvisar (si no encuentras receta del tipo pedido)

Reglas: no repetir receta misma semana, alternar sub-tipos, cenas ligeras, respetar slot (lunch→almuerzo, dinner→cena, any→cualquiera).

Responde solo esto, sin markdown ni backticks:
[{"d":${firstDay},"l":ID,"n":ID},...]`;

    // Helper: parse AI text response and normalize
    const parseResponse = (text, provider) => {
      if (!text) return { error: provider + ' devolvió respuesta vacía' };
      let jsonStr = '';
      const mdMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (mdMatch) {
        jsonStr = mdMatch[1].trim();
      } else {
        const arrMatch = text.match(/\[[\s\S]*\]/);
        jsonStr = arrMatch ? arrMatch[0] : '';
      }
      if (!jsonStr) return { error: provider + ' no devolvió JSON válido' };
      try {
        const raw = JSON.parse(jsonStr);
        if (!Array.isArray(raw)) return { error: 'Formato inesperado (no es array)' };
        return {
          days: raw.map(e => ({
            day: e.d || e.day,
            lunchId: e.l || e.lunchId,
            dinnerId: e.n || e.dinnerId,
          })),
        };
      } catch {
        return { error: 'JSON mal formado de ' + provider };
      }
    };

    // Try Gemini first
    if (geminiKey) {
      try {
        const geminiRes = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: { temperature: 0.7, maxOutputTokens: 8192 },
            }),
          }
        );

        const geminiData = await geminiRes.json();

        if (geminiRes.ok) {
          const candidate = geminiData?.candidates?.[0];
          const finishReason = candidate?.finishReason || 'UNKNOWN';
          const parts = candidate?.content?.parts || [];
          const text = parts.map(p => p.text || '').join('');
          console.log('[Gemini] finishReason:', finishReason, 'textLen:', text.length);

          if (finishReason === 'MAX_TOKENS') {
            console.log('[Gemini] Truncado por tokens, intentando Groq...');
          } else if (text) {
            const result = parseResponse(text, 'Gemini');
            if (result.days) {
              return res.json({ days: result.days, month, year, provider: 'gemini' });
            }
            console.log('[Gemini] Parse error, intentando Groq...');
          }
        } else {
          console.log('[Gemini] HTTP', geminiRes.status, 'intentando Groq...');
        }
      } catch (e) {
        console.log('[Gemini] Error de red, intentando Groq:', e.message);
      }
    }

    // Fallback: Groq
    if (groqKey) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${groqKey}`,
          },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [
              { role: 'system', content: 'Eres un nutricionista. Responde ÚNICAMENTE con un array JSON válido, sin explicaciones, sin markdown, sin backticks. Nada de texto fuera del JSON. Solo el array.' },
              { role: 'user', content: prompt },
            ],
            temperature: 0.7,
            max_tokens: 8192,
          }),
        });

        if (groqRes.ok) {
          const groqData = await groqRes.json();
          const text = groqData?.choices?.[0]?.message?.content || '';
          const finishReason = groqData?.choices?.[0]?.finish_reason || '';
          console.log('[Groq] finishReason:', finishReason, 'textLen:', text.length);
          console.log('[Groq] text preview:', text.slice(0, 300));

          const result = parseResponse(text, 'Groq');
          if (result.days) {
            return res.json({ days: result.days, month, year, provider: 'groq' });
          }
          return res.status(500).json({ error: result.error });
        }

        if (groqRes.status === 429) {
          return res.status(429).json({ error: 'Límite de Groq alcanzado. Espera unos segundos.' });
        }

        const groqErr = await groqRes.json().catch(() => ({}));
        return res.status(502).json({ error: 'Error Groq: ' + (groqErr?.error?.message || `HTTP ${groqRes.status}`) });
      } catch (e) {
        return res.status(500).json({ error: 'Error de red Groq: ' + e.message });
      }
    }

    return res.status(500).json({ error: 'No se pudo generar el menú con ningún proveedor. Revisa las API keys.' });
  } catch (e) {
    res.status(500).json({ error: 'Error: ' + e.message });
  }
});

// === INGREDIENTES ===

// Obtener ingredientes de una receta
app.get('/api/recipes/:id/ingredients', optionalAuth, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT id, name, category, quantity, unit FROM recipe_ingredients WHERE recipe_id = $1 ORDER BY id",
      [req.params.id]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Guardar ingredientes de una receta
app.post('/api/recipes/:id/ingredients', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { ingredients } = req.body;
  if (!Array.isArray(ingredients)) {
    return res.status(400).json({ error: 'ingredients debe ser un array de { name, category, quantity?, unit? }' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM recipe_ingredients WHERE recipe_id = $1", [id]);
    for (const ing of ingredients) {
      await client.query(
        "INSERT INTO recipe_ingredients (recipe_id, name, category, quantity, unit) VALUES ($1, $2, $3, $4, $5)",
        [id, ing.name, ing.category || '', ing.quantity || '', ing.unit || '']
      );
    }
    await client.query('COMMIT');
    res.json({ message: 'Ingredientes guardados', count: ingredients.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

// Scrape ingredientes desde Cookidoo
app.get('/api/recipes/:id/ingredients/scrape', authMiddleware, async (req, res) => {
  try {
    const { rows } = await query(
      "SELECT cookidooId FROM recipes WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Receta no encontrada' });
    if (!rows[0].cookidooid) return res.status(400).json({ error: 'La receta no tiene cookidooId' });
    const response = await fetch(`https://cookidoo.es/recipes/recipe/es-ES/${rows[0].cookidooid}`);
    const html = await response.text();
    const matches = [...html.matchAll(/<span data-testid="ingredient-amount">(.*?)<\/span>\s*(?:<span[^>]*>([^<]+)<\/span>\s*)?<span[^>]*>([^<]+)<\/span>/gi)];
    const extracted = matches.map(m => {
      const amount = (m[1] || '').trim();
      const name = (m[3] || m[2] || '').trim();
      const parts = amount.split(/\s+/);
      const unit = parts.length > 1 ? parts.pop() : '';
      const quantity = parts.length > 0 ? parts.join(' ') : amount;
      return { name, quantity, unit, category: '' };
    }).filter(i => i.name);
    if (extracted.length === 0) {
      const fallback = [...html.matchAll(/(?:de\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s*(?:de\s+[a-záéíóúñ]+\s*[a-záéíóúñ]*)?)(?:\s*<\/span>|\s*<)/g)];
      extracted.push(...fallback.map(m => ({ name: m[1].trim(), category: '' })).filter(i => i.name && i.name.length > 3));
    }
    res.json({ ingredients: extracted });
  } catch (e) {
    res.status(500).json({ error: 'Error al scrapear: ' + e.message });
  }
});

// Obtener todos los ingredientes de las recetas del calendario de un mes
app.get('/api/ingredients/from-calendar', optionalAuth, async (req, res) => {
  const { month, year, menuId } = req.query;
  const mid = parseInt(menuId) || 1;
  try {
    const { rows } = await query(
      `SELECT DISTINCT ri.name, ri.category, ri.quantity, ri.unit, r.name as recipe_name, r.type as recipe_type
       FROM recipe_ingredients ri
       JOIN calendar c ON (ri.recipe_id = c.lunch_recipe_id OR ri.recipe_id = c.dinner_recipe_id) AND c.menu_id = $1
       JOIN recipes r ON ri.recipe_id = r.id
       WHERE c.month = $2 AND c.year = $3
       ORDER BY ri.name`,
      [mid, month, year]
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === COOKIDOO ===

const CIAM_LOGIN_SRV_URL = 'https://ciam.prod.cookidoo.vorwerk-digital.com/login-srv/login';

const COOKIDOO_BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
};

function cleanApiKey(value) {
  return (value || '').replace(/[^\x21-\x7E]/g, '');
}

function cleanSettingValue(key, value) {
  return key.endsWith('_api_key') && typeof value === 'string' ? cleanApiKey(value) : value;
}

function getMenuId(req) {
  return parseInt(req.query.menuId) || 1;
}

async function getSettings(menuId, keys) {
  const { rows } = await query(
    `SELECT key, value FROM settings WHERE menu_id = $1 AND key = ANY($2)`,
    [menuId, keys]
  );
  const map = {};
  rows.forEach(r => map[r.key] = r.value);
  return map;
}

const cookidooCookieJars = new Map();

function parseCookies(res) {
  const cookies = {};
  const setCookieLines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  setCookieLines.forEach(line => {
    const match = line.match(/^([^=]+)=([^;]+)/);
    if (match) cookies[match[1].trim()] = match[2].trim();
  });
  return cookies;
}

function mergeCookies(jar, newCookies) {
  Object.assign(jar, newCookies);
}

function makeCookieHeader(jar) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function getCookieJarKey(email) {
  return `ck_${email}`;
}

async function cookidooLogin(menuId, email, password) {
  const settings = await getSettings(menuId, ['cookidoo_country', 'cookidoo_language']);
  const country = settings.cookidoo_country || 'es';
  const language = settings.cookidoo_language || 'es-ES';

  const jarKey = getCookieJarKey(email);
  const jar = cookidooCookieJars.get(jarKey) || {};
  cookidooCookieJars.set(jarKey, jar);

  const dbg = (...args) => console.log('[cookidoo-login]', ...args);

  const loginUrl = `https://cookidoo.${country}/profile/${language}/login?redirectAfterLogin=%2Ffoundation%2F${language}%2Ffor-you`;
  const loginRes = await fetch(loginUrl, { redirect: 'manual', headers: COOKIDOO_BROWSER_HEADERS });
  dbg('GET login page ->', loginRes.status, loginRes.headers.get('location'));
  let location = loginRes.headers.get('location');
  let redirectCount = 0;
  const maxRedirects = 10;

  while (location && redirectCount < maxRedirects) {
    redirectCount++;
    const currentUrl = location.startsWith('http') ? location : `https://cookidoo.${country}${location}`;
    const redirectRes = await fetch(currentUrl, {
      redirect: 'manual',
      headers: location.includes('ciam') ? COOKIDOO_BROWSER_HEADERS : { ...COOKIDOO_BROWSER_HEADERS, Cookie: makeCookieHeader(jar) },
    });
    mergeCookies(jar, parseCookies(redirectRes));
    dbg('redirect', redirectCount, location, '->', redirectRes.status, redirectRes.headers.get('location'), 'cookies:', Object.keys(jar));
    location = redirectRes.headers.get('location');
    if (!location && redirectRes.status === 200) {
      const html = await redirectRes.text();
      const match = html.match(/<input[^>]*name=["']requestId["'][^>]*value=["']([^"']+)["']/);
      dbg('login page body: requestId found =', !!match, 'length =', html.length);
      if (!match) {
        dbg('login page snippet:', html.slice(0, 500).replace(/\s+/g, ' '));
      }
      if (match) {
        const requestId = match[1];
        const formActionMatch = html.match(/<form[^>]*action=["']([^"']+)["']/i);
        const formAction = formActionMatch ? formActionMatch[1].replace(/&amp;/g, '&') : null;
        const postUrl = formAction
          ? (formAction.startsWith('http') ? formAction : new URL(formAction, currentUrl).toString())
          : CIAM_LOGIN_SRV_URL;
        dbg('form action found =', formAction, '-> posting to', postUrl);
        const postOrigin = new URL(postUrl).origin;
        const loginData = new URLSearchParams({ requestId, username: email, password });
        const authRes = await fetch(postUrl, {
          method: 'POST',
          redirect: 'manual',
          body: loginData.toString(),
          headers: {
            ...COOKIDOO_BROWSER_HEADERS,
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            Origin: new URL(currentUrl).origin,
            Referer: currentUrl,
            'Sec-Fetch-Site': new URL(currentUrl).origin === postOrigin ? 'same-origin' : 'same-site',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-User': '?1',
            'Upgrade-Insecure-Requests': '1',
            Cookie: makeCookieHeader(jar),
          },
        });
        mergeCookies(jar, parseCookies(authRes));
        dbg('POST auth ->', authRes.status, authRes.headers.get('location'), 'cookies:', Object.keys(jar));
        if (!authRes.headers.get('location')) {
          const authHtml = await authRes.text();
          dbg('auth response snippet:', authHtml.slice(0, 800).replace(/\s+/g, ' '));
        }
        let postLocation = authRes.headers.get('location');
        let lastUrl = postUrl;
        let postCount = 0;
        while (postLocation && postCount < maxRedirects) {
          postCount++;
          const nextUrl = postLocation.startsWith('http') ? postLocation : new URL(postLocation, lastUrl).toString();
          const postRes = await fetch(nextUrl, {
            redirect: 'manual',
            headers: { ...COOKIDOO_BROWSER_HEADERS, Cookie: makeCookieHeader(jar) },
          });
          mergeCookies(jar, parseCookies(postRes));
          dbg('post-auth redirect', postCount, postLocation, '->', postRes.status, postRes.headers.get('location'), 'cookies:', Object.keys(jar));
          lastUrl = nextUrl;
          postLocation = postRes.headers.get('location');
        }
        if (!jar['_oauth2_proxy'] && !jar['v-authenticated']) {
          dbg('FAILED - final cookie jar keys:', Object.keys(jar));
          throw new Error('No se recibieron cookies de autenticación. Credenciales incorrectas.');
        }
        return;
      }
    }
  }
  throw new Error('No se pudo completar el login. Verifica tus credenciales.');
}

async function ensureCookidooAuth(menuId, email) {
  if (!email) {
    const settings = await getSettings(menuId, ['cookidoo_email']);
    email = settings.cookidoo_email;
  }
  if (!email) throw new Error('Configura el email de Cookidoo en Ajustes');
  const jarKey = getCookieJarKey(email);
  const jar = cookidooCookieJars.get(jarKey) || {};
  if (jar['_oauth2_proxy'] && jar['v-authenticated']) return jar;
  const settings = await getSettings(menuId, ['cookidoo_password']);
  const password = settings.cookidoo_password;
  if (!password) throw new Error('Configura la contraseña de Cookidoo en Ajustes');
  await cookidooLogin(menuId, email, password);
  return cookidooCookieJars.get(jarKey);
}

app.post('/api/cookidoo/login', async (req, res) => {
  const menuId = getMenuId(req);
  try {
    let { email, password } = req.body || {};
    if (!email || !password) {
      const settings = await getSettings(menuId, ['cookidoo_email', 'cookidoo_password']);
      email = settings.cookidoo_email;
      password = settings.cookidoo_password;
    }
    if (!email || !password) {
      return res.status(400).json({
        error: 'No hay credenciales. Guárdalas en Ajustes o pásalas en el body.',
      });
    }
    const jarKey = getCookieJarKey(email);
    cookidooCookieJars.set(jarKey, {});
    await cookidooLogin(menuId, email, password);
    res.json({ ok: true });
  } catch (e) {
    res.status(401).json({ error: e.message });
  }
});

app.get('/api/cookidoo/search', async (req, res) => {
  const menuId = getMenuId(req);
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: 'Parámetro "q" requerido' });
  let jar;
  try {
    jar = await ensureCookidooAuth(menuId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const settings = await getSettings(menuId, ['cookidoo_country', 'cookidoo_language']);
    const country = settings.cookidoo_country || 'es';
    const language = settings.cookidoo_language || 'es-ES';
    const locale = language.split('-')[0];

    const searchUrl = `https://cookidoo.${country}/search/${locale}?query=${encodeURIComponent(q)}&pageSize=15`;
    const apiRes = await fetch(searchUrl, {
      headers: {
        ...COOKIDOO_BROWSER_HEADERS,
        Accept: 'application/json',
        Cookie: makeCookieHeader(jar),
      },
    });
    if (!apiRes.ok) {
      const text = await apiRes.text();
      return res.status(502).json({ error: 'Error al buscar en Cookidoo', detail: text.slice(0, 200) });
    }
    const body = await apiRes.json();
    const hits = body.data || body.recipes || [];
    const results = hits.map((item) => ({
      name: item.title || item.name || '—',
      id: item.id,
    }));
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cookidoo/predefined', async (req, res) => {
  const menuId = getMenuId(req);
  let jar;
  try {
    jar = await ensureCookidooAuth(menuId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const settings = await getSettings(menuId, ['cookidoo_country', 'cookidoo_language']);
    const country = settings.cookidoo_country || 'es';
    const language = settings.cookidoo_language || 'es-ES';
    const locale = language.split('-')[0];

    const searches = [
      { term: 'lentejas guiso', type: 'legumbres' },
      { term: 'garbanzos', type: 'legumbres' },
      { term: 'alubias', type: 'legumbres' },
      { term: 'verduras salteadas', type: 'verduras' },
      { term: 'ensalada', type: 'verduras' },
      { term: 'salmon', type: 'pescado' },
      { term: 'merluza', type: 'pescado' },
      { term: 'pasta', type: 'pasta' },
      { term: 'espaguetis', type: 'pasta' },
      { term: 'pollo', type: 'carne' },
      { term: 'ternera', type: 'carne' },
      { term: 'arroz', type: 'arroz' },
      { term: 'paella', type: 'arroz' },
      { term: 'tortilla', type: 'cena' },
      { term: 'cena rapida', type: 'cena' },
    ];

    const allResults = [];
    const seenIds = new Set();
    const seenNames = new Set();

    // Normalize name for similarity comparison
    const normalize = (s) => {
      return (s || '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // quita acentos
        .replace(/[^a-z0-9áéíóúñü]/g, ' ')               // solo letras/num + espacio
        .replace(/\s+/g, ' ')                             // normaliza espacios
        .replace(/\(.*?\)/g, '')                          // quita paréntesis
        .trim();
    };

    for (const s of searches) {
      try {
        const searchUrl = `https://cookidoo.${country}/search/${locale}?query=${encodeURIComponent(s.term)}&pageSize=4`;
        const apiRes = await fetch(searchUrl, {
          headers: {
            ...COOKIDOO_BROWSER_HEADERS,
            Accept: 'application/json',
            Cookie: makeCookieHeader(jar),
          },
        });
        if (!apiRes.ok) continue;
        const body = await apiRes.json();
        const hits = body.data || body.recipes || [];
        for (const item of hits) {
          const name = item.title || item.name || '';
          const norm = normalize(name);
          if (!seenIds.has(item.id) && !seenNames.has(norm)) {
            seenIds.add(item.id);
            seenNames.add(norm);
            allResults.push({
              name: name || '—',
              id: item.id,
              suggestedType: s.type,
            });
          }
        }
      } catch {
        // skip failed searches
      }
    }

    // Filter out already-imported recipes
    const cookidooIds = allResults.map(r => r.id).filter(Boolean);
    if (cookidooIds.length > 0) {
      const { rows: existing } = await query(
        `SELECT cookidooId FROM recipes WHERE cookidooId = ANY($1) AND menu_id = $2`,
        [cookidooIds, menuId]
      );
      const existingIds = new Set(existing.map(r => r.cookidooid));
      res.json({
        results: allResults.map(r => ({
          ...r,
          alreadyImported: existingIds.has(r.id),
        })),
      });
    } else {
      res.json({ results: allResults });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cookidoo/add-to-shopping-list', async (req, res) => {
  const menuId = getMenuId(req);
  const { recipeIds } = req.body;
  if (!Array.isArray(recipeIds) || recipeIds.length === 0) {
    return res.status(400).json({ error: 'recipeIds debe ser un array no vacío' });
  }
  let jar;
  try {
    jar = await ensureCookidooAuth(menuId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const settings = await getSettings(menuId, ['cookidoo_country', 'cookidoo_language']);
    const country = settings.cookidoo_country || 'es';
    const language = settings.cookidoo_language || 'es-ES';
    const apiRes = await fetch(`https://cookidoo.${country}/shopping/${language}/recipes/add`, {
      method: 'POST',
      headers: {
        ...COOKIDOO_BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Cookie: makeCookieHeader(jar),
      },
      body: JSON.stringify({ recipeIDs: recipeIds }),
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      return res.json({ ok: true, data });
    }
    if (apiRes.status === 401) {
      const settings = await getSettings(menuId, ['cookidoo_email']);
      const key = getCookieJarKey(settings.cookidoo_email || '');
      cookidooCookieJars.set(key, {});
      return res.status(401).json({ error: 'Sesión expirada. Vuelve a iniciar sesión.' });
    }
    const errText = await apiRes.text();
    res.status(502).json({ error: 'Error en Cookidoo', detail: errText.slice(0, 200) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/cookidoo/add-to-calendar', async (req, res) => {
  const menuId = getMenuId(req);
  const { entries } = req.body;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries debe ser un array no vacío de { cookidooId, date }' });
  }
  let jar;
  try {
    jar = await ensureCookidooAuth(menuId);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  try {
    const settings = await getSettings(menuId, ['cookidoo_country', 'cookidoo_language']);
    const country = settings.cookidoo_country || 'es';
    const language = settings.cookidoo_language || 'es-ES';

    const results = [];
    for (const entry of entries) {
      try {
        const apiRes = await fetch(`https://${country}.tmmobile.vorwerk-digital.com/planning/${language}/api/my-day`, {
          method: 'PUT',
          headers: {
            ...COOKIDOO_BROWSER_HEADERS,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(jar['v-token']
              ? { Authorization: `Bearer ${jar['v-token']}` }
              : { Cookie: makeCookieHeader(jar) }),
          },
          body: JSON.stringify({ dayKey: entry.date, recipeIds: [entry.cookidooId] }),
        });
        mergeCookies(jar, parseCookies(apiRes));
        if (!apiRes.ok) {
          const err = await apiRes.text();
          results.push({ cookidooId: entry.cookidooId, date: entry.date, ok: false, error: err.slice(0, 100) });
        } else {
          results.push({ cookidooId: entry.cookidooId, date: entry.date, ok: true });
        }
      } catch (e) {
        results.push({ cookidooId: entry.cookidooId, date: entry.date, ok: false, error: e.message });
      }
    }
    res.json({ results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// === SETTINGS ===

app.get('/api/settings', optionalAuth, async (req, res) => {
  const menuId = req.query.menuId || 1;
  try {
    const { rows } = await query(
      "SELECT key, value FROM settings WHERE menu_id = $1",
      [menuId]
    );
    const settings = {};
    rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  const { key, value } = req.body;
  const menuId = req.query.menuId || 1;
  if (!key) return res.status(400).json({ error: 'key requerido' });
  try {
    await query(
      `INSERT INTO settings (key, value, menu_id) VALUES ($1, $2, $3)
       ON CONFLICT (key, menu_id) DO UPDATE SET value = $2`,
      [key, cleanSettingValue(key, value), menuId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/settings/batch', authMiddleware, async (req, res) => {
  const entries = req.body;
  const menuId = req.query.menuId || 1;
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'Se requiere un array de { key, value }' });
  }
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      if (entry.key) {
        await client.query(
          `INSERT INTO settings (key, value, menu_id) VALUES ($1, $2, $3)
           ON CONFLICT (key, menu_id) DO UPDATE SET value = $2`,
          [entry.key, cleanSettingValue(entry.key, entry.value), menuId]
        );
      }
    }
    await client.query('COMMIT');
    res.json({ ok: true, count: entries.length });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally {
    client.release();
  }
});

const listenPort = process.env.PORT || port;

// Serve built Angular app in production (must be after all API routes)
const distPath = path.join(__dirname, '..', 'dist', 'menubox', 'browser');
const hasDist = fs.existsSync(distPath);

if (hasDist) {
  app.use(express.static(distPath));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api')) {
      res.sendFile(path.join(distPath, 'index.html'));
    } else {
      next();
    }
  });
}

app.listen(listenPort, () => {
  console.log(`Servidor corriendo en puerto ${listenPort}`);
});