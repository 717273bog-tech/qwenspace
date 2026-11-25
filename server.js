const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const { Pool } = require('pg');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// === Папка для фото ===
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// === Загрузка файлов ===
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Только изображения'));
  }
});

// === Статика ===
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

// === PostgreSQL ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway') ? { rejectUnauthorized: false } : false
});

async function initDB() {
  try {
    console.log('🔌 Подключаюсь к базе данных...');
    
    console.log('📋 Создаю таблицу users...');
    await pool.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE,
      name TEXT,
      password TEXT,
      avatar TEXT,
      bio TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ Таблица users готова');
    
    console.log('📋 Создаю таблицу posts...');
    await pool.query(`CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      author_id INTEGER,
      content TEXT,
      image_url TEXT,
      type TEXT DEFAULT 'public',
      recipient_id INTEGER,
      tag TEXT,
      likes INTEGER DEFAULT 0,
      liked_by TEXT DEFAULT '[]',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ Таблица posts готова');
    
    console.log('📋 Создаю таблицу messages...');
    await pool.query(`CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      from_id INTEGER,
      to_id INTEGER,
      content TEXT,
      is_read INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
    console.log('✅ Таблица messages готова');
    
    console.log('✅ Все таблицы базы данных созданы!');
  } catch(e) {
    console.error('❌ Ошибка инициализации БД:', e);
    console.error('❌ Детали ошибки:', e.message);
    console.error('❌ Stack:', e.stack);
  }
}

initDB().catch(e => console.error('❌ Критическая ошибка инициализации:', e));

initDB().catch(e => console.error('❌ Ошибка инициализации БД:', e));

const onlineUsers = new Map();

// === РЕГИСТРАЦИЯ ===
app.post('/api/register', async (req, res) => {
  console.log('📥 Получен запрос регистрации:', req.body);
  const { username, name, password, avatar } = req.body;
  
  if (!username || !password || !name) {
    console.log('❌ Не заполнены все поля');
    return res.status(400).json({ error: 'Заполни все поля' });
  }
  
  const cleanUsername = username.toLowerCase().trim();
  
  try {
    console.log('🔍 Проверяю, существует ли username:', cleanUsername);
    const existing = await pool.query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
    
    if (existing.rows.length > 0) {
      console.log('❌ Username уже занят:', cleanUsername);
      return res.status(400).json({ error: 'Этот username уже занят' });
    }
    
    console.log('✅ Username свободен, создаю пользователя...');
    const hash = await bcrypt.hash(password, 10);
    const finalAvatar = avatar || '👤';
    
    const result = await pool.query(
      'INSERT INTO users (username, name, password, avatar) VALUES ($1, $2, $3, $4) RETURNING id',
      [cleanUsername, name, hash, finalAvatar]
    );
    
    const newId = result.rows[0].id;
    console.log(`✅ Пользователь создан: ${cleanUsername} (ID: ${newId})`);
    
    res.json({ id: newId, username: cleanUsername, name, avatar: finalAvatar });
  } catch(e) {
    console.error('❌ Ошибка регистрации:', e);
    res.status(500).json({ error: e.message });
  }
});

// === ВХОД ===
// === ВХОД ===
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  console.log('🔑 Попытка входа:', username);
  
  try {
    // Ищем пользователя
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
    
    if (result.rows.length === 0) {
      console.log('❌ Пользователь не найден');
      return res.status(401).json({ error: 'Неверные данные' });
    }

    const user = result.rows[0];
    console.log('✅ Пользователь найден, проверяем пароль...');

    // Сравниваем пароль
    const isMatch = await bcrypt.compare(password, user.password);
    
    if (!isMatch) {
      console.log('❌ Неверный пароль');
      return res.status(401).json({ error: 'Неверные данные' });
    }

    console.log('✅ Вход успешен!');
    // Отправляем данные без пароля
    res.json({ 
      id: user.id, 
      username: user.username, 
      name: user.name, 
      avatar: user.avatar 
    });

  } catch(e) {
    console.error('❌ Ошибка при входе:', e);
    res.status(500).json({ error: 'Ошибка сервера: ' + e.message });
  }
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get('/api/users', async (req, res) => {
  const result = await pool.query('SELECT id, username, name, avatar FROM users');
  res.json(result.rows);
});

// === ПРОФИЛЬ ===
app.get('/api/profile/:username', async (req, res) => {
  const username = req.params.username.toLowerCase().trim();
  const userRes = await pool.query('SELECT id, username, name, avatar, bio FROM users WHERE username = $1', [username]);
  if (userRes.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
  const user = userRes.rows[0];
  const statsRes = await pool.query('SELECT COUNT(*) as posts, COALESCE(SUM(likes),0) as likes FROM posts WHERE author_id = $1', [user.id]);
  const postsRes = await pool.query(`SELECT * FROM posts WHERE author_id = $1 AND type IN ('public','mention') ORDER BY created_at DESC`, [user.id]);
  const photosRes = await pool.query(`SELECT id, image_url FROM posts WHERE author_id = $1 AND image_url IS NOT NULL`, [user.id]);
  res.json({
    user,
    stats: statsRes.rows[0],
    posts: postsRes.rows.map(p => ({...p, liked_by: JSON.parse(p.liked_by)})),
    photos: photosRes.rows
  });
});

app.post('/api/profile/bio', async (req, res) => {
  const { userId, bio } = req.body;
  await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, userId]);
  res.json({ success: true });
});

// === ЗАГРУЗКА ФОТО ===
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// === ПОСТЫ ===
app.get('/api/posts', async (req, res) => {
  const result = await pool.query(`SELECT p.*, u.username as author_username, u.name as author_name, u.avatar as author_avatar 
          FROM posts p JOIN users u ON p.author_id = u.id ORDER BY p.created_at DESC`);
  res.json(result.rows.map(r => ({...r, liked_by: JSON.parse(r.liked_by)})));
});

app.post('/api/posts', async (req, res) => {
  const { author_id, content, type, recipient_id, tag, image_url } = req.body;
  try {
    const authorRes = await pool.query('SELECT id FROM users WHERE id = $1', [author_id]);
    if (authorRes.rows.length === 0) return res.status(401).json({ error: 'Аккаунт не найден' });
    const result = await pool.query(
      `INSERT INTO posts (author_id, content, type, recipient_id, tag, image_url) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [author_id, content, type, recipient_id || null, tag, image_url || null]
    );
    const post = result.rows[0];
    const userRes = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [author_id]);
    const user = userRes.rows[0];
    const fullPost = { ...post, author_username: user.username, author_name: user.name, author_avatar: user.avatar, liked_by: [] };
    io.emit('new_post', fullPost);
    res.json(fullPost);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/like', async (req, res) => {
  const { postId, userId } = req.body;
  const row = await pool.query('SELECT liked_by FROM posts WHERE id = $1', [postId]);
  let likes = JSON.parse(row.rows[0].liked_by);
  if (likes.includes(userId)) likes = likes.filter(id => id !== userId);
  else likes.push(userId);
  await pool.query('UPDATE posts SET likes = $1, liked_by = $2 WHERE id = $3', [likes.length, JSON.stringify(likes), postId]);
  io.emit('update_likes', { postId, likes, likedBy: likes });
  res.json({ success: true });
});

// === АДМИН ===
app.delete('/api/posts/:postId', async (req, res) => {
  const { userId } = req.body;
  const user = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
  if (user.rows.length === 0 || user.rows[0].username !== 'admin') {
    return res.status(403).json({ error: 'Только админ' });
  }
  await pool.query('DELETE FROM posts WHERE id = $1', [req.params.postId]);
  io.emit('post_deleted', req.params.postId);
  res.json({ success: true });
});

app.delete('/api/users/:userId', async (req, res) => {
  const { adminId } = req.body;
  const admin = await pool.query('SELECT username FROM users WHERE id = $1', [adminId]);
  if (admin.rows.length === 0 || admin.rows[0].username !== 'admin') {
    return res.status(403).json({ error: 'Только админ' });
  }
  const targetId = req.params.userId;
  await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [targetId]);
  await pool.query('DELETE FROM posts WHERE author_id = $1', [targetId]);
  await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
  io.emit('user_banned', targetId);
  res.json({ success: true });
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', async (req, res) => {
  const myId = req.query.myId;
  const result = await pool.query(
    `SELECT m.*, u_from.username as from_username, u_to.username as to_username 
     FROM messages m JOIN users u_from ON m.from_id = u_from.id JOIN users u_to ON m.to_id = u_to.id 
     WHERE (m.from_id = $1 AND m.to_id = $2) OR (m.from_id = $2 AND m.to_id = $1) ORDER BY m.created_at ASC`,
    [myId, req.params.userId]
  );
  res.json(result.rows);
});

app.post('/api/messages', async (req, res) => {
  const { from_id, to_id, content } = req.body;
  await pool.query('INSERT INTO messages (from_id, to_id, content) VALUES ($1, $2, $3)', [from_id, to_id, content]);
  io.to(`user_${to_id}`).emit('new_message', { from_id, content, date: Date.now() });
  res.json({ success: true });
});

// === ОНЛАЙН ===
app.get('/api/online', async (req, res) => {
  const onlineIds = Array.from(onlineUsers.values());
  if (onlineIds.length === 0) return res.json([]);
  const placeholders = onlineIds.map((_, i) => `$${i + 1}`).join(',');
  const result = await pool.query(`SELECT id, username, name, avatar FROM users WHERE id IN (${placeholders})`, onlineIds);
  res.json(result.rows);
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  socket.on('join_user', async (userId) => {
    onlineUsers.set(socket.id, userId);
    socket.join(`user_${userId}`);
    const userRes = await pool.query('SELECT id, username, name, avatar FROM users WHERE id = $1', [userId]);
    if (userRes.rows.length > 0) {
      const user = userRes.rows[0];
      io.emit('user_online', user);
      console.log(`🟢 ${user.username} зашёл`);
    }
  });
  socket.on('disconnect', () => {
    const userId = onlineUsers.get(socket.id);
    if (userId) {
      onlineUsers.delete(socket.id);
      pool.query('SELECT id, username FROM users WHERE id = $1', [userId]).then(r => {
        if (r.rows.length > 0) {
          io.emit('user_offline', { userId: r.rows[0].id, username: r.rows[0].username });
          console.log(`🔴 ${r.rows[0].username} вышел`);
        }
      });
    }
  });
});

// === Создание админа ===
setTimeout(async () => {
  try {
    const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash('SuperAdmin2026!', 10);
      await pool.query(
        "INSERT INTO users (username, name, password, avatar, bio) VALUES ('admin', 'Главный Админ', $1, '👑', 'Я слежу за порядком.')",
        [hash]
      );
      console.log('👑 Админ создан');
    }
  } catch(e) { console.error('⚠️ Админ:', e.message); }
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on port ${PORT}`);
});
