const { Pool } = require('pg');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const CONFIG_PATH = path.join(__dirname, '.auth_secret');

function getJwtSecret() {
  if (fs.existsSync(CONFIG_PATH)) {
    return fs.readFileSync(CONFIG_PATH, 'utf-8').trim();
  }
  const secret = crypto.randomBytes(64).toString('hex');
  fs.writeFileSync(CONFIG_PATH, secret, 'utf-8');
  console.log('🔐 JWT_SECRET generado y guardado en .auth_secret');
  return secret;
}
const JWT_SECRET = getJwtSecret();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:toor@localhost:5432/menubox',
});

async function query(text, params) {
  const result = await pool.query(text, params);
  return result;
}

async function initDatabase() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT FALSE`);

  await query(`
    CREATE TABLE IF NOT EXISTS login_history (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username TEXT NOT NULL,
      success BOOLEAN NOT NULL,
      ip TEXT DEFAULT '',
      user_agent TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS menus (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS user_menus (
      user_id INTEGER NOT NULL REFERENCES users(id),
      menu_id INTEGER NOT NULL REFERENCES menus(id),
      role TEXT NOT NULL DEFAULT 'editor',
      PRIMARY KEY (user_id, menu_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS recipes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      slot TEXT NOT NULL,
      tags TEXT DEFAULT '',
      cookidooId TEXT DEFAULT '',
      menu_id INTEGER DEFAULT 1
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS recipe_ingredients (
      id SERIAL PRIMARY KEY,
      recipe_id INTEGER NOT NULL REFERENCES recipes(id),
      name TEXT NOT NULL,
      category TEXT DEFAULT '',
      quantity TEXT DEFAULT '',
      unit TEXT DEFAULT ''
    )
  `);

  await query(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS quantity TEXT DEFAULT ''`);
  await query(`ALTER TABLE recipe_ingredients ADD COLUMN IF NOT EXISTS unit TEXT DEFAULT ''`);

  await query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS servings INTEGER DEFAULT 4`);
  await query(`ALTER TABLE recipes ADD COLUMN IF NOT EXISTS image_url TEXT DEFAULT ''`);

  await query(`
    CREATE TABLE IF NOT EXISTS calendar (
      day INTEGER NOT NULL,
      month INTEGER NOT NULL,
      year INTEGER NOT NULL,
      lunch_recipe_id INTEGER,
      dinner_recipe_id INTEGER,
      menu_id INTEGER DEFAULT 1,
      UNIQUE(day, month, year, menu_id)
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT NOT NULL,
      value TEXT DEFAULT '',
      menu_id INTEGER DEFAULT 1,
      PRIMARY KEY (key, menu_id)
    )
  `);

  // Admin por defecto
  const existing = await query("SELECT id FROM users WHERE username = $1", ['admin']);
  if (existing.rows.length === 0) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('admin123', 10);
    const adminResult = await query(
      "INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id",
      ['admin', 'admin@menubox.app', hash]
    );
    const adminId = adminResult.rows[0].id;
    await query("UPDATE users SET is_superadmin = TRUE WHERE id = $1", [adminId]);
    console.log('👤 Usuario admin creado (admin / admin123)');

    const menuResult = await query(
      "INSERT INTO menus (name, owner_id) VALUES ($1, $2) RETURNING id",
      ['Mi Menú', adminId]
    );
    const menuId = menuResult.rows[0].id;
    await query(
      "INSERT INTO user_menus (user_id, menu_id, role) VALUES ($1, $2, $3)",
      [adminId, menuId, 'admin']
    );
    console.log('📋 Menú por defecto creado con id', menuId);
  } else {
    await query("UPDATE users SET is_superadmin = TRUE WHERE id = $1", [existing.rows[0].id]);
    console.log('👤 Usuario admin ya existe (id:', existing.rows[0].id, ')');
  }
}

initDatabase().catch(err => {
  console.error('Error inicializando base de datos:', err.message);
  process.exit(1);
});

module.exports = { query, pool };
module.exports.JWT_SECRET = JWT_SECRET;