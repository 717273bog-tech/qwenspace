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
const io = new Server(server, { cors: { origin: "*" } });

// === Папка для фото и видео ===
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    try {
        fs.mkdirSync(uploadsDir, { recursive: true });
        console.log('📁 Папка uploads создана');
    } catch(e) {
        console.error('❌ Не удалось создать папку uploads:', e.message);
    }
}

// === Загрузка файлов ===
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        // Проверяем, что папка существует перед записью
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});

const upload = multer({
    storage,
    limits: { 
        fileSize: 50 * 1024 * 1024, // 50MB
        files: 1
    },
    fileFilter: (req, file, cb) => {
        console.log('📥 Загрузка файла:', file.originalname, file.mimetype, file.size);
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
            cb(null, true);
        } else {
            cb(new Error('Только изображения и видео'));
        }
    }
});

// === ВАЖНО: Увеличиваем лимиты Express ===
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// === Статика ===
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir, {
    maxAge: '1d', // кэшируем на день
    fallthrough: true
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => console.error('⚠️ Ошибка пула:', err.message));

async function initDB() {
    const maxRetries = 5;
    let retries = 0;
    while (retries < maxRetries) {
        try {
            console.log(`🔌 Попытка подключения к БД (${retries + 1}/${maxRetries})...`);
            await pool.query('SELECT 1');
            console.log('✅ Соединение с БД установлено');

            await pool.query(`CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, username TEXT UNIQUE, name TEXT, password TEXT,
                avatar TEXT, bio TEXT DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY, author_id INTEGER, content TEXT, media_url TEXT,
                media_type TEXT, type TEXT DEFAULT 'public', recipient_id INTEGER, tag TEXT,
                likes INTEGER DEFAULT 0, liked_by TEXT DEFAULT '[]', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, from_id INTEGER, to_id INTEGER, content TEXT,
                is_read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS follows (
                id SERIAL PRIMARY KEY, follower_id INTEGER NOT NULL, following_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(follower_id, following_id)
            )`);

            try { await pool.query(`ALTER TABLE posts RENAME COLUMN image_url TO media_url`); } catch(e) {}
            try { await pool.query(`ALTER TABLE posts ADD COLUMN media_type TEXT`); } catch(e) {}

            console.log('✅ Все таблицы созданы!');
            return;
        } catch(e) {
            retries++;
            console.error(`❌ Ошибка (${retries}):`, e.message);
            if (retries >= maxRetries) return;
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}
initDB();

const onlineUsers = new Map();

// === РЕГИСТРАЦИЯ ===
app.post('/api/register', async (req, res) => {
    const { username, name, password, avatar } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Заполни все поля' });
    const cleanUsername = username.toLowerCase().trim();
    try {
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Этот username уже занят' });
        const hash = await bcrypt.hash(password, 10);
        const finalAvatar = avatar || '👤';
        const result = await pool.query(
            'INSERT INTO users (username, name, password, avatar) VALUES ($1, $2, $3, $4) RETURNING id',
            [cleanUsername, name, hash, finalAvatar]
        );
        res.json({ id: result.rows[0].id, username: cleanUsername, name, avatar: finalAvatar });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// === ВХОД ===
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Неверные данные' });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: 'Неверные данные' });
        res.json({ id: user.id, username: user.username, name: user.name, avatar: user.avatar });
    } catch(e) { res.status(500).json({ error: 'Ошибка сервера: ' + e.message }); }
});

app.get('/api/users', async (req, res) => {
    const result = await pool.query('SELECT id, username, name, avatar FROM users');
    res.json(result.rows);
});

// === ЗАГРУЗКА ФАЙЛОВ (С ЛОГАМИ) ===
app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            console.error('❌ Ошибка multer:', err);
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    return res.status(400).json({ error: 'Файл слишком большой (макс. 50 МБ)' });
                }
                return res.status(400).json({ error: 'Ошибка загрузки: ' + err.message });
            }
            return res.status(400).json({ error: err.message });
        }
        if (!req.file) {
            console.error('❌ Файл не получен');
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        
        const isVideo = req.file.mimetype.startsWith('video/');
        const url = '/uploads/' + req.file.filename;
        console.log('✅ Файл сохранён:', url, req.file.size, 'байт');
        
        // Проверяем, что файл реально существует
        const filePath = path.join(uploadsDir, req.file.filename);
        if (!fs.existsSync(filePath)) {
            console.error('❌ Файл не найден после сохранения!');
            return res.status(500).json({ error: 'Файл не сохранился' });
        }
        
        res.json({ url, type: isVideo ? 'video' : 'image' });
    });
});

// === ПРОФИЛЬ ===
app.get('/api/profile/:username', async (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const myId = req.query.myId ? parseInt(req.query.myId) : null;
    const userRes = await pool.query('SELECT id, username, name, avatar, bio FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Пользователь не найден' });
    const user = userRes.rows[0];

    const statsRes = await pool.query('SELECT COUNT(*) as posts, COALESCE(SUM(likes),0) as likes FROM posts WHERE author_id = $1', [user.id]);
    const postsRes = await pool.query(`SELECT * FROM posts WHERE author_id = $1 AND type IN ('public','mention') ORDER BY created_at DESC`, [user.id]);
    const photosRes = await pool.query(`SELECT id, media_url, media_type FROM posts WHERE author_id = $1 AND media_url IS NOT NULL`, [user.id]);

    const followersCount = await pool.query('SELECT COUNT(*) FROM follows WHERE following_id = $1', [user.id]);
    const followingCount = await pool.query('SELECT COUNT(*) FROM follows WHERE follower_id = $1', [user.id]);
    const friendsCount = await pool.query(
        `SELECT COUNT(*) FROM follows f1 JOIN follows f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id WHERE f1.follower_id = $1`,
        [user.id]
    );

    let followStatus = null;
    if (myId && myId !== user.id) {
        const iFollow = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [myId, user.id]);
        const followsMe = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [user.id, myId]);
        followStatus = { iFollow: iFollow.rows.length > 0, followsMe: followsMe.rows.length > 0, isFriend: iFollow.rows.length > 0 && followsMe.rows.length > 0 };
    }

    res.json({
        user,
        stats: { ...statsRes.rows[0], followers: followersCount.rows[0].count, following: followingCount.rows[0].count, friends: friendsCount.rows[0].count },
        posts: postsRes.rows.map(p => ({...p, liked_by: JSON.parse(p.liked_by)})),
        photos: photosRes.rows,
        followStatus
    });
});

app.get('/api/followers/:userId', async (req, res) => {
    const result = await pool.query(`SELECT u.id, u.username, u.name, u.avatar FROM follows f JOIN users u ON f.follower_id = u.id WHERE f.following_id = $1 ORDER BY f.created_at DESC`, [req.params.userId]);
    res.json(result.rows);
});
app.get('/api/following/:userId', async (req, res) => {
    const result = await pool.query(`SELECT u.id, u.username, u.name, u.avatar FROM follows f JOIN users u ON f.following_id = u.id WHERE f.follower_id = $1 ORDER BY f.created_at DESC`, [req.params.userId]);
    res.json(result.rows);
});
app.get('/api/friends/:userId', async (req, res) => {
    const result = await pool.query(
        `SELECT u.id, u.username, u.name, u.avatar FROM follows f1 JOIN follows f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id JOIN users u ON f1.following_id = u.id WHERE f1.follower_id = $1 ORDER BY u.name`,
        [req.params.userId]
    );
    res.json(result.rows);
});

app.post('/api/follow', async (req, res) => {
    const { followerId, followingId } = req.body;
    if (followerId === followingId) return res.status(400).json({ error: 'Нельзя подписаться на себя' });
    try {
        await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [followerId, followingId]);
        const mutual = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [followingId, followerId]);
        if (mutual.rows.length > 0) {
            const u1 = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [followerId]);
            const u2 = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [followingId]);
            io.to(`user_${followerId}`).emit('new_friend', { friend: u2.rows[0] });
            io.to(`user_${followingId}`).emit('new_friend', { friend: u1.rows[0] });
        }
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/follow', async (req, res) => {
    const { followerId, followingId } = req.body;
    await pool.query('DELETE FROM follows WHERE follower_id = $1 AND following_id = $2', [followerId, followingId]);
    res.json({ success: true });
});

app.post('/api/profile/bio', async (req, res) => {
    const { userId, bio } = req.body;
    await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, userId]);
    res.json({ success: true });
});

// === ПОСТЫ ===
app.get('/api/posts', async (req, res) => {
    const myId = req.query.myId ? parseInt(req.query.myId) : null;
    const baseQuery = `SELECT p.*, u.username as author_username, u.name as author_name, u.avatar as author_avatar FROM posts p JOIN users u ON p.author_id = u.id`;
    let query, params;
    if (myId) {
        query = `${baseQuery} LEFT JOIN follows f ON f.follower_id = $1 AND f.following_id = p.author_id
                 WHERE p.type IN ('public','mention') OR p.author_id = $1 OR f.follower_id IS NOT NULL OR (p.type = 'private' AND (p.author_id = $1 OR p.recipient_id = $1))
                 ORDER BY p.created_at DESC`;
        params = [myId];
    } else {
        query = `${baseQuery} WHERE p.type IN ('public','mention') ORDER BY p.created_at DESC`;
        params = [];
    }
    const result = await pool.query(query, params);
    res.json(result.rows.map(r => ({...r, liked_by: JSON.parse(r.liked_by)})));
});

app.post('/api/posts', async (req, res) => {
    const { author_id, content, type, recipient_id, tag, media_url, media_type } = req.body;
    try {
        const result = await pool.query(
            `INSERT INTO posts (author_id, content, type, recipient_id, tag, media_url, media_type) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [author_id, content, type, recipient_id || null, tag, media_url || null, media_type || null]
        );
        const post = result.rows[0];
        const userRes = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [author_id]);
        const user = userRes.rows[0];
        const fullPost = { ...post, author_username: user.username, author_name: user.name, author_avatar: user.avatar, liked_by: [] };
        io.emit('new_post', fullPost);
        res.json(fullPost);
    } catch(e) { res.status(500).json({ error: e.message }); }
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
    if (user.rows.length === 0 || user.rows[0].username !== 'admin') return res.status(403).json({ error: 'Только админ' });
    await pool.query('DELETE FROM posts WHERE id = $1', [req.params.postId]);
    io.emit('post_deleted', req.params.postId);
    res.json({ success: true });
});

app.delete('/api/users/:userId', async (req, res) => {
    const { adminId } = req.body;
    const admin = await pool.query('SELECT username FROM users WHERE id = $1', [adminId]);
    if (admin.rows.length === 0 || admin.rows[0].username !== 'admin') return res.status(403).json({ error: 'Только админ' });
    const targetId = req.params.userId;
    await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [targetId]);
    await pool.query('DELETE FROM posts WHERE author_id = $1', [targetId]);
    await pool.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [targetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    io.emit('user_banned', targetId);
    res.json({ success: true });
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', async (req, res) => {
    const myId = req.query.myId;
    const result = await pool.query(
        `SELECT m.*, u_from.username as from_username, u_to.username as to_username FROM messages m JOIN users u_from ON m.from_id = u_from.id JOIN users u_to ON m.to_id = u_to.id
         WHERE (m.from_id = $1 AND m.to_id = $2) OR (m.from_id = $2 AND m.to_id = $1) ORDER BY m.created_at ASC`,
        [myId, req.params.userId]
    );
    res.json(result.rows);
});

app.post('/api/messages', async (req, res) => {
    const { from_id, to_id, content } = req.body;
    await pool.query('INSERT INTO messages (from_id, to_id, content) VALUES ($1, $2, $3)', [from_id, to_id, content]);
    const userRes = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [from_id]);
    const sender = userRes.rows[0];
    io.to(`user_${to_id}`).emit('new_message', { from_id, content, date: Date.now(), from_username: sender.username, from_name: sender.name, from_avatar: sender.avatar });
    res.json({ success: true });
});

app.get('/api/online', async (req, res) => {
    const onlineIds = Array.from(onlineUsers.values());
    if (onlineIds.length === 0) return res.json([]);
    const placeholders = onlineIds.map((_, i) => `$${i + 1}`).join(',');
    const result = await pool.query(`SELECT id, username, name, avatar FROM users WHERE id IN (${placeholders})`, onlineIds);
    res.json(result.rows);
});

// === ГЛОБАЛЬНЫЙ ОБРАБОТЧИК ОШИБОК ===
app.use((err, req, res, next) => {
    console.error('❌ Глобальная ошибка:', err);
    res.status(500).json({ error: err.message || 'Внутренняя ошибка сервера' });
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
    console.log('✅ User connected:', socket.id);
    socket.on('join_user', async (userId) => {
        onlineUsers.set(socket.id, userId);
        socket.join(`user_${userId}`);
        const userRes = await pool.query('SELECT id, username, name, avatar FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length > 0) io.emit('user_online', userRes.rows[0]);
    });
    socket.on('call_request', (data) => io.to(`user_${data.toId}`).emit('incoming_call', data));
    socket.on('call_accept', (data) => io.to(`user_${data.fromId}`).emit('call_accepted', data));
    socket.on('call_reject', (data) => io.to(`user_${data.fromId}`).emit('call_rejected', data));
    socket.on('call_end', (data) => io.to(`user_${data.toId}`).emit('call_ended', data));
    socket.on('call_busy', (data) => io.to(`user_${data.toId}`).emit('call_busy_signal', data));
    socket.on('webrtc_offer', (data) => io.to(`user_${data.toId}`).emit('webrtc_offer', data));
    socket.on('webrtc_answer', (data) => io.to(`user_${data.toId}`).emit('webrtc_answer', data));
    socket.on('webrtc_ice', (data) => io.to(`user_${data.toId}`).emit('webrtc_ice', data));
    socket.on('disconnect', () => {
        const userId = onlineUsers.get(socket.id);
        if (userId) {
            onlineUsers.delete(socket.id);
            pool.query('SELECT id, username FROM users WHERE id = $1', [userId]).then(r => {
                if (r.rows.length > 0) io.emit('user_offline', { userId: r.rows[0].id, username: r.rows[0].username });
            });
        }
    });
});

setTimeout(async () => {
    try {
        const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
        if (existing.rows.length === 0) {
            const hash = await bcrypt.hash('SuperAdmin2026!', 10);
            await pool.query("INSERT INTO users (username, name, password, avatar, bio) VALUES ('admin', 'Главный Админ', $1, '👑', 'Я слежу за порядком.')", [hash]);
            console.log('👑 Админ создан');
        }
    } catch(e) { console.error('⚠️ Админ:', e.message); }
}, 3000);

app.get('/ping', (req, res) => res.json({ status: 'alive' }));

// === ДИАГНОСТИЧЕСКИЙ РОУТ ===
app.get('/api/debug/uploads', (req, res) => {
    try {
        const files = fs.readdirSync(uploadsDir);
        res.json({
            uploadsDir,
            exists: fs.existsSync(uploadsDir),
            filesCount: files.length,
            files: files.slice(0, 20)
        });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Server running on port ${PORT}`));
