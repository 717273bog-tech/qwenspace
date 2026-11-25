const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const sqlite3 = require('sqlite3').verbose();
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

// === База данных ===
const db = new sqlite3.Database('./database.db');

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE,
    name TEXT,
    password TEXT,
    avatar TEXT,
    bio TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    author_id INTEGER,
    content TEXT,
    image_url TEXT,
    type TEXT DEFAULT 'public',
    recipient_id INTEGER,
    tag TEXT,
    likes INTEGER DEFAULT 0,
    liked_by TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_id INTEGER,
    to_id INTEGER,
    content TEXT,
    is_read INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);  // === Создание Супер-Админа ===
  setTimeout(() => {
    db.get('SELECT id FROM users WHERE username = ?', ['admin'], (err, row) => {
      if(!row) {
        bcrypt.hash('SuperAdmin2026!', 10).then(hash => {
          db.run(`INSERT INTO users (username, name, password, avatar, bio) VALUES ('admin', 'Главный Админ', ?, '👑', 'Я слежу за порядком.')`, [hash], (err) => {
            if(err) console.log('⚠️ Ошибка создания админа:', err.message);
            else console.log('👑 Админ создан! Логин: admin | Пароль: password');
          });
        });
      }
    });
  }, 1000);
});

const onlineUsers = new Map();

// === РЕГИСТРАЦИЯ ===
app.post('/api/register', async (req, res) => {
  console.log('📥 Регистрация:', req.body.username);
  const { username, name, password, avatar } = req.body;
  if (!username || !password || !name) return res.status(400).json({ error: 'Заполни все поля' });
  
  const cleanUsername = username.toLowerCase().trim();
  
  db.get('SELECT id FROM users WHERE username = ?', [cleanUsername], async (err, existing) => {
    if (existing) return res.status(400).json({ error: 'Этот username уже занят' });
    
    try {
      const hash = await bcrypt.hash(password, 10);
      const finalAvatar = avatar || '👤';
      
      db.run('INSERT INTO users (username, name, password, avatar) VALUES (?, ?, ?, ?)', 
        [cleanUsername, name, hash, finalAvatar], function(err) {
          if (err) return res.status(500).json({ error: 'Ошибка сервера' });
          console.log(`✅ Создан: ${cleanUsername} (ID: ${this.lastID})`);
          res.json({ id: this.lastID, username: cleanUsername, name, avatar: finalAvatar });
        });
    } catch(e) {
      res.status(500).json({ error: e.message });
    }
  });
});

// === ВХОД ===
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  db.get('SELECT * FROM users WHERE username = ?', [username.toLowerCase()], async (err, user) => {
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Неверные данные' });
    }
    res.json(user);
  });
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get('/api/users', (req, res) => {
  db.all('SELECT id, username, name, avatar FROM users', [], (err, rows) => res.json(rows));
});

// === ПРОФИЛЬ ===
app.get('/api/profile/:username', (req, res) => {
  const username = req.params.username.toLowerCase().trim();
  db.get('SELECT id, username, name, avatar, bio FROM users WHERE username = ?', [username], (err, user) => {
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    db.get('SELECT COUNT(*) as posts, COALESCE(SUM(likes),0) as likes FROM posts WHERE author_id = ?', [user.id], (err, stats) => {
      db.all(`SELECT * FROM posts WHERE author_id = ? AND type IN ('public','mention') ORDER BY created_at DESC`, [user.id], (err, posts) => {
        db.all(`SELECT id, image_url FROM posts WHERE author_id = ? AND image_url IS NOT NULL`, [user.id], (err, photos) => {
          res.json({ 
            user, 
            stats: stats || { posts: 0, likes: 0 },
            posts: (posts || []).map(p => ({...p, liked_by: JSON.parse(p.liked_by)})),
            photos: photos || []
          });
        });
      });
    });
  });
});

app.post('/api/profile/bio', (req, res) => {
  const { userId, bio } = req.body;
  db.run('UPDATE users SET bio = ? WHERE id = ?', [bio, userId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// === ЗАГРУЗКА ФОТО ===
app.post('/api/upload', upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
  res.json({ url: '/uploads/' + req.file.filename });
});

// === ПОСТЫ ===
app.get('/api/posts', (req, res) => {
  db.all(`SELECT p.*, u.username as author_username, u.name as author_name, u.avatar as author_avatar 
          FROM posts p JOIN users u ON p.author_id = u.id ORDER BY p.created_at DESC`, [], (err, rows) => {
    res.json(rows.map(r => ({...r, liked_by: JSON.parse(r.liked_by)})));
  });
});

app.post('/api/posts', (req, res) => {
  const { author_id, content, type, recipient_id, tag, image_url } = req.body;

  // Проверяем, существует ли автор поста
  db.get('SELECT id FROM users WHERE id = ?', [author_id], (err, author) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    if (!author) {
      return res.status(401).json({
        error: 'Аккаунт не найден. Выйди и зарегистрируйся заново.'
      });
    }

    db.run(
      'INSERT INTO posts (author_id, content, type, recipient_id, tag, image_url) VALUES (?, ?, ?, ?, ?, ?)',
      [author_id, content, type, recipient_id || null, tag, image_url || null],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        db.get(
          `SELECT p.*, u.username as author_username, u.name as author_name, u.avatar as author_avatar
           FROM posts p
           JOIN users u ON p.author_id = u.id
           WHERE p.id = ?`,
          [this.lastID],
          (err, post) => {
            if (err) {
              return res.status(500).json({ error: err.message });
            }

            if (!post) {
              return res.status(500).json({ error: 'Пост не найден после создания' });
            }

            post.liked_by = [];
            io.emit('new_post', post);
            res.json(post);
          }
        );
      }
    );
  });
});

app.post('/api/like', (req, res) => {
  const { postId, userId } = req.body;
  db.get('SELECT liked_by FROM posts WHERE id = ?', [postId], (err, row) => {
    let likes = JSON.parse(row.liked_by);
    if (likes.includes(userId)) likes = likes.filter(id => id !== userId);
    else likes.push(userId);
    db.run('UPDATE posts SET likes = ?, liked_by = ? WHERE id = ?', [likes.length, JSON.stringify(likes), postId]);
    io.emit('update_likes', { postId, likes, likedBy: likes });
    res.json({ success: true });
  });
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', (req, res) => {
  const myId = req.query.myId;
  db.all(`SELECT m.*, u_from.username as from_username, u_to.username as to_username 
          FROM messages m JOIN users u_from ON m.from_id = u_from.id JOIN users u_to ON m.to_id = u_to.id 
          WHERE (m.from_id = ? AND m.to_id = ?) OR (m.from_id = ? AND m.to_id = ?) ORDER BY m.created_at ASC`, 
          [myId, req.params.userId, req.params.userId, myId], (err, rows) => res.json(rows));
});

app.post('/api/messages', (req, res) => {
  const { from_id, to_id, content } = req.body;
  db.run('INSERT INTO messages (from_id, to_id, content) VALUES (?, ?, ?)', 
    [from_id, to_id, content], function() {
      io.to(`user_${to_id}`).emit('new_message', { from_id, content, date: Date.now() });
      res.json({ success: true });
    });
});

// === ОНЛАЙН ===
app.get('/api/online', (req, res) => {
  const onlineIds = Array.from(onlineUsers.values());
  if(onlineIds.length === 0) return res.json([]);
  const placeholders = onlineIds.map(() => '?').join(',');
  db.all(`SELECT id, username, name, avatar FROM users WHERE id IN (${placeholders})`, onlineIds, (err, rows) => res.json(rows || []));
});
// === АДМИН: Удалить пост ===
app.delete('/api/posts/:postId', (req, res) => {
  const { userId } = req.body; // ID того, кто удаляет
  
  // Проверяем, админ ли это
  db.get('SELECT username FROM users WHERE id = ?', [userId], (err, user) => {
    if(err || !user || user.username !== 'admin') {
      return res.status(403).json({ error: 'Только админ может удалять посты' });
    }
    
    db.run('DELETE FROM posts WHERE id = ?', [req.params.postId], function() {
      io.emit('post_deleted', req.params.postId); // Сообщаем всем, что пост удалён
      res.json({ success: true });
    });
  });
});

// === АДМИН: Удалить пользователя ===
app.delete('/api/users/:userId', (req, res) => {
  const { adminId } = req.body;
  
  db.get('SELECT username FROM users WHERE id = ?', [adminId], (err, admin) => {
    if(err || !admin || admin.username !== 'admin') {
      return res.status(403).json({ error: 'Только админ может блокировать' });
    }
    
    const targetId = req.params.userId;
    
    // Удаляем всё, что связано с пользователем
    db.serialize(() => {
      db.run('DELETE FROM messages WHERE from_id = ? OR to_id = ?', [targetId, targetId]);
      db.run('DELETE FROM posts WHERE author_id = ?', [targetId]);
      db.run('DELETE FROM users WHERE id = ?', [targetId], function() {
        io.emit('user_banned', targetId);
        res.json({ success: true });
      });
    });
  });
});
// === SOCKET.IO ===
io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.id);
  socket.on('join_user', (userId) => {
    onlineUsers.set(socket.id, userId);
    socket.join(`user_${userId}`);
    db.get('SELECT id, username, name, avatar FROM users WHERE id = ?', [userId], (err, user) => {
      if(user) {
        io.emit('user_online', user);
        console.log(`🟢 ${user.username} зашёл`);
      }
    });
  });
  socket.on('disconnect', () => {
    const userId = onlineUsers.get(socket.id);
    if(userId) {
      onlineUsers.delete(socket.id);
      db.get('SELECT id, username FROM users WHERE id = ?', [userId], (err, user) => {
        if(user) {
          io.emit('user_offline', { userId: user.id, username: user.username });
          console.log(`🔴 ${user.username} вышел`);
        }
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});