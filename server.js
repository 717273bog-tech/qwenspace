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

// === Папка для файлов ===
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) { try { fs.mkdirSync(uploadsDir, { recursive: true }); } catch(e) {} }

// === Multer ===
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
        cb(null, unique + path.extname(file.originalname));
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) cb(null, true);
        else cb(new Error('Только изображения и видео'));
    }
});

// === Статика ===
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(uploadsDir, { maxAge: '1d' }));

// === PostgreSQL ===
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/postgres',
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});
pool.on('error', (err) => console.error('⚠️ Ошибка БД:', err.message));

async function initDB() {
    let retries = 0;
    while (retries < 5) {
        try {
            await pool.query('SELECT 1');
            console.log('✅ БД подключена');
            await pool.query(`CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY, username TEXT UNIQUE, name TEXT, password TEXT,
                avatar TEXT, bio TEXT DEFAULT '', badge TEXT DEFAULT '', badge_color TEXT DEFAULT '',
                permissions TEXT DEFAULT '[]', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS posts (
                id SERIAL PRIMARY KEY, author_id INTEGER, content TEXT, media_url TEXT, media_type TEXT,
                type TEXT DEFAULT 'public', recipient_id INTEGER, tag TEXT, likes INTEGER DEFAULT 0,
                liked_by TEXT DEFAULT '[]', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS messages (
                id SERIAL PRIMARY KEY, from_id INTEGER, to_id INTEGER, content TEXT,
                is_read INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )`);
            await pool.query(`CREATE TABLE IF NOT EXISTS follows (
                id SERIAL PRIMARY KEY, follower_id INTEGER NOT NULL, following_id INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(follower_id, following_id)
            )`);
            // Миграции
            try { await pool.query(`ALTER TABLE posts RENAME COLUMN image_url TO media_url`); } catch(e) {}
            try { await pool.query(`ALTER TABLE posts ADD COLUMN media_type TEXT`); } catch(e) {}
            try { await pool.query(`ALTER TABLE users ADD COLUMN badge TEXT DEFAULT ''`); } catch(e) {}
            try { await pool.query(`ALTER TABLE users ADD COLUMN badge_color TEXT DEFAULT ''`); } catch(e) {}
            try { await pool.query(`ALTER TABLE users ADD COLUMN permissions TEXT DEFAULT '[]'`); } catch(e) {}
            console.log('✅ Таблицы готовы');
            return;
        } catch(e) {
            retries++;
            console.error(`❌ Ошибка БД (${retries}):`, e.message);
            if (retries >= 5) return;
            await new Promise(r => setTimeout(r, 3000));
        }
    }
}
initDB();

const onlineUsers = new Map();

// === ПРОВЕРКА ПРАВ ===
async function isAdmin(userId) {
    const r = await pool.query('SELECT username FROM users WHERE id = $1', [userId]);
    return r.rows.length > 0 && r.rows[0].username === 'admin';
}

async function hasPermission(userId, permission) {
    if (await isAdmin(userId)) return true;
    const r = await pool.query('SELECT permissions FROM users WHERE id = $1', [userId]);
    if (r.rows.length === 0) return false;
    try {
        const perms = typeof r.rows[0].permissions === 'string' ? JSON.parse(r.rows[0].permissions) : r.rows[0].permissions;
        return Array.isArray(perms) && perms.includes(permission);
    } catch(e) { return false; }
}

function parsePerms(p) {
    if (!p) return [];
    try { return typeof p === 'string' ? JSON.parse(p) : p; } catch(e) { return []; }
}

// === АВТОРИЗАЦИЯ ===
app.post('/api/register', async (req, res) => {
    const { username, name, password, avatar } = req.body;
    if (!username || !password || !name) return res.status(400).json({ error: 'Заполни все поля' });
    const cleanUsername = username.toLowerCase().trim();
    try {
        const existing = await pool.query('SELECT id FROM users WHERE username = $1', [cleanUsername]);
        if (existing.rows.length > 0) return res.status(400).json({ error: 'Username занят' });
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO users (username, name, password, avatar) VALUES ($1, $2, $3, $4) RETURNING id',
            [cleanUsername, name, hash, avatar || '👤']
        );
        res.json({ id: result.rows[0].id, username: cleanUsername, name, avatar: avatar || '👤', permissions: [] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Неверные данные' });
        const user = result.rows[0];
        if (!(await bcrypt.compare(password, user.password))) return res.status(401).json({ error: 'Неверные данные' });
        res.json({ id: user.id, username: user.username, name: user.name, avatar: user.avatar, permissions: parsePerms(user.permissions) });
    } catch(e) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// === ПОЛЬЗОВАТЕЛИ ===
app.get('/api/users', async (req, res) => {
    const result = await pool.query('SELECT id, username, name, avatar, badge, badge_color, permissions FROM users');
    res.json(result.rows.map(r => ({ ...r, permissions: parsePerms(r.permissions) })));
});

app.get('/api/profile/:username', async (req, res) => {
    const username = req.params.username.toLowerCase().trim();
    const myId = req.query.myId ? parseInt(req.query.myId) : null;
    const userRes = await pool.query('SELECT id, username, name, avatar, bio, badge, badge_color, permissions FROM users WHERE username = $1', [username]);
    if (userRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
    const user = { ...userRes.rows[0], permissions: parsePerms(userRes.rows[0].permissions) };

    const statsRes = await pool.query('SELECT COUNT(*) as posts, COALESCE(SUM(likes),0) as likes FROM posts WHERE author_id = $1', [user.id]);
    const postsRes = await pool.query(`SELECT * FROM posts WHERE author_id = $1 AND type IN ('public','mention') ORDER BY created_at DESC`, [user.id]);
    const photosRes = await pool.query(`SELECT id, media_url, media_type FROM posts WHERE author_id = $1 AND media_url IS NOT NULL`, [user.id]);
    const followersCount = await pool.query('SELECT COUNT(*) FROM follows WHERE following_id = $1', [user.id]);
    const followingCount = await pool.query('SELECT COUNT(*) FROM follows WHERE follower_id = $1', [user.id]);
    const friendsCount = await pool.query(`SELECT COUNT(*) FROM follows f1 JOIN follows f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id WHERE f1.follower_id = $1`, [user.id]);

    let followStatus = null;
    if (myId && myId !== user.id) {
        const iFollow = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [myId, user.id]);
        const followsMe = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [user.id, myId]);
        followStatus = { iFollow: iFollow.rows.length > 0, followsMe: followsMe.rows.length > 0, isFriend: iFollow.rows.length > 0 && followsMe.rows.length > 0 };
    }

    res.json({
        user,
        stats: { ...statsRes.rows[0], followers: followersCount.rows[0].count, following: followingCount.rows[0].count, friends: friendsCount.rows[0].count },
        posts: postsRes.rows.map(p => ({ ...p, liked_by: JSON.parse(p.liked_by) })),
        photos: photosRes.rows,
        followStatus
    });
});

app.post('/api/profile/bio', async (req, res) => {
    const { userId, bio } = req.body;
    await pool.query('UPDATE users SET bio = $1 WHERE id = $2', [bio, userId]);
    res.json({ success: true });
});

// === НАСТРОЙКИ ===
app.post('/api/change-name', async (req, res) => {
    const { userId, name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Имя пустое' });
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', [name.trim(), userId]);
    res.json({ success: true, name: name.trim() });
});

app.post('/api/change-avatar', async (req, res) => {
    const { userId, avatar } = req.body;
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, userId]);
    res.json({ success: true, avatar });
});

app.post('/api/change-password', async (req, res) => {
    const { userId, oldPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Минимум 4 символа' });
    try {
        const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
        if (!(await bcrypt.compare(oldPassword, userRes.rows[0].password))) return res.status(400).json({ error: 'Неверный пароль' });
        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/account/:userId', async (req, res) => {
    const userId = parseInt(req.params.userId);
    const { password } = req.body;
    try {
        const userRes = await pool.query('SELECT password FROM users WHERE id = $1', [userId]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: 'Не найден' });
        if (!(await bcrypt.compare(password, userRes.rows[0].password))) return res.status(400).json({ error: 'Неверный пароль' });
        await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [userId]);
        await pool.query('DELETE FROM posts WHERE author_id = $1', [userId]);
        await pool.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [userId]);
        await pool.query('DELETE FROM users WHERE id = $1', [userId]);
        io.emit('user_banned', userId);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// === ПОДПИСКИ ===
app.post('/api/follow', async (req, res) => {
    const { followerId, followingId } = req.body;
    if (followerId === followingId) return res.status(400).json({ error: 'Нельзя на себя' });
    try {
        await pool.query('INSERT INTO follows (follower_id, following_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [followerId, followingId]);
        const mutual = await pool.query('SELECT 1 FROM follows WHERE follower_id = $1 AND following_id = $2', [followingId, followerId]);
        if (mutual.rows.length > 0) {
            const u1 = await pool.query('SELECT id, username, name, avatar FROM users WHERE id = $1', [followerId]);
            const u2 = await pool.query('SELECT id, username, name, avatar FROM users WHERE id = $1', [followingId]);
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

app.get('/api/followers/:userId', async (req, res) => {
    const r = await pool.query(`SELECT u.id, u.username, u.name, u.avatar, u.badge, u.badge_color FROM follows f JOIN users u ON f.follower_id = u.id WHERE f.following_id = $1 ORDER BY f.created_at DESC`, [req.params.userId]);
    res.json(r.rows);
});
app.get('/api/following/:userId', async (req, res) => {
    const r = await pool.query(`SELECT u.id, u.username, u.name, u.avatar, u.badge, u.badge_color FROM follows f JOIN users u ON f.following_id = u.id WHERE f.follower_id = $1 ORDER BY f.created_at DESC`, [req.params.userId]);
    res.json(r.rows);
});
app.get('/api/friends/:userId', async (req, res) => {
    const r = await pool.query(`SELECT u.id, u.username, u.name, u.avatar, u.badge, u.badge_color FROM follows f1 JOIN follows f2 ON f1.follower_id = f2.following_id AND f1.following_id = f2.follower_id JOIN users u ON f1.following_id = u.id WHERE f1.follower_id = $1 ORDER BY u.name`, [req.params.userId]);
    res.json(r.rows);
});

// === ЗАГРУЗКА ===
app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.message || 'Ошибка загрузки' });
        if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });
        const isVideo = req.file.mimetype.startsWith('video/');
        res.json({ url: '/uploads/' + req.file.filename, type: isVideo ? 'video' : 'image' });
    });
});

// === ПОСТЫ ===
app.get('/api/posts', async (req, res) => {
    const myId = req.query.myId ? parseInt(req.query.myId) : null;
    const base = `SELECT p.*, u.username as author_username, u.name as author_name, u.avatar as author_avatar, u.badge as author_badge, u.badge_color as author_badge_color FROM posts p JOIN users u ON p.author_id = u.id`;
    let query, params;
    if (myId) {
        query = `${base} LEFT JOIN follows f ON f.follower_id = $1 AND f.following_id = p.author_id
                 WHERE p.type IN ('public','mention') OR p.author_id = $1 OR f.follower_id IS NOT NULL OR (p.type = 'private' AND (p.author_id = $1 OR p.recipient_id = $1))
                 ORDER BY p.created_at DESC`;
        params = [myId];
    } else {
        query = `${base} WHERE p.type IN ('public','mention') ORDER BY p.created_at DESC`;
        params = [];
    }
    const result = await pool.query(query, params);
    res.json(result.rows.map(r => ({ ...r, liked_by: JSON.parse(r.liked_by) })));
});

app.post('/api/posts', async (req, res) => {
    const { author_id, content, type, recipient_id, tag, media_url, media_type } = req.body;
    try {
        const result = await pool.query(`INSERT INTO posts (author_id, content, type, recipient_id, tag, media_url, media_type) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [author_id, content, type, recipient_id || null, tag, media_url || null, media_type || null]);
        const post = result.rows[0];
        const userRes = await pool.query('SELECT username, name, avatar, badge, badge_color FROM users WHERE id = $1', [author_id]);
        const user = userRes.rows[0];
        const fullPost = { ...post, author_username: user.username, author_name: user.name, author_avatar: user.avatar, author_badge: user.badge, author_badge_color: user.badge_color, liked_by: [] };
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
    io.emit('update_likes', { postId, likes: likes.length, likedBy: likes });
    res.json({ success: true });
});

// === МОДЕРАЦИЯ (по правам) ===
app.post('/api/mod/delete-post', async (req, res) => {
    const { userId, postId } = req.body;
    if (!(await hasPermission(userId, 'delete_posts'))) return res.status(403).json({ error: 'Нет прав' });
    await pool.query('DELETE FROM posts WHERE id = $1', [postId]);
    io.emit('post_deleted', postId);
    res.json({ success: true });
});

app.post('/api/mod/ban', async (req, res) => {
    const { userId, targetId } = req.body;
    if (!(await hasPermission(userId, 'ban_users'))) return res.status(403).json({ error: 'Нет прав' });
    if (await isAdmin(targetId)) return res.status(403).json({ error: 'Нельзя банить админа' });
    await pool.query('DELETE FROM messages WHERE from_id = $1 OR to_id = $1', [targetId]);
    await pool.query('DELETE FROM posts WHERE author_id = $1', [targetId]);
    await pool.query('DELETE FROM follows WHERE follower_id = $1 OR following_id = $1', [targetId]);
    await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
    io.emit('user_banned', targetId);
    res.json({ success: true });
});

app.get('/api/mod/stats', async (req, res) => {
    if (!(await hasPermission(parseInt(req.query.userId), 'view_stats'))) return res.status(403).json({ error: 'Нет прав' });
    const users = await pool.query('SELECT COUNT(*) FROM users');
    const posts = await pool.query('SELECT COUNT(*) FROM posts');
    const messages = await pool.query('SELECT COUNT(*) FROM messages');
    const follows = await pool.query('SELECT COUNT(*) FROM follows');
    const likes = await pool.query('SELECT COALESCE(SUM(likes), 0) as total FROM posts');
    res.json({ users: users.rows[0].count, posts: posts.rows[0].count, messages: messages.rows[0].count, follows: follows.rows[0].count, likes: likes.rows[0].total, online: onlineUsers.size });
});

app.get('/api/mod/users', async (req, res) => {
    if (!(await hasPermission(parseInt(req.query.userId), 'view_stats'))) return res.status(403).json({ error: 'Нет прав' });
    const r = await pool.query(`SELECT u.id, u.username, u.name, u.avatar, u.bio, u.badge, u.badge_color, u.permissions, u.created_at,
        (SELECT COUNT(*) FROM posts WHERE author_id = u.id) as posts_count,
        (SELECT COUNT(*) FROM follows WHERE follower_id = u.id) as following_count,
        (SELECT COUNT(*) FROM follows WHERE following_id = u.id) as followers_count
        FROM users u ORDER BY u.created_at DESC`);
    res.json(r.rows.map(row => ({ ...row, permissions: parsePerms(row.permissions) })));
});

// === ВЫДАЧА СТАТУСА И ПРАВ ===
app.post('/api/mod/set-badge', async (req, res) => {
    const { userId, targetId, badge, color, permissions } = req.body;
    if (!(await hasPermission(userId, 'set_badges'))) return res.status(403).json({ error: 'Нет прав' });
    if (await isAdmin(targetId)) return res.status(403).json({ error: 'Нельзя менять админа' });
    const permsJson = JSON.stringify(permissions || []);
    await pool.query('UPDATE users SET badge = $1, badge_color = $2, permissions = $3 WHERE id = $4',
        [badge || '', color || '#feca57', permsJson, targetId]);
    const user = await pool.query('SELECT id, username, name, avatar, badge, badge_color, permissions FROM users WHERE id = $1', [targetId]);
    const updated = { ...user.rows[0], permissions: parsePerms(user.rows[0].permissions) };
    io.emit('badge_updated', updated);
    res.json({ success: true });
});

app.post('/api/mod/remove-badge', async (req, res) => {
    const { userId, targetId } = req.body;
    if (!(await hasPermission(userId, 'set_badges'))) return res.status(403).json({ error: 'Нет прав' });
    if (await isAdmin(targetId)) return res.status(403).json({ error: 'Нельзя менять админа' });
    await pool.query('UPDATE users SET badge = $1, badge_color = $2, permissions = $3 WHERE id = $4', ['', '', '[]', targetId]);
    io.emit('badge_updated', { id: targetId, badge: '', badge_color: '', permissions: [] });
    res.json({ success: true });
});

// === СООБЩЕНИЯ ===
app.get('/api/messages/:userId', async (req, res) => {
    const myId = req.query.myId;
    const r = await pool.query(`SELECT m.*, u_from.username as from_username, u_to.username as to_username FROM messages m JOIN users u_from ON m.from_id = u_from.id JOIN users u_to ON m.to_id = u_to.id WHERE (m.from_id = $1 AND m.to_id = $2) OR (m.from_id = $2 AND m.to_id = $1) ORDER BY m.created_at ASC`, [myId, req.params.userId]);
    res.json(r.rows);
});

app.post('/api/messages', async (req, res) => {
    const { from_id, to_id, content } = req.body;
    await pool.query('INSERT INTO messages (from_id, to_id, content) VALUES ($1, $2, $3)', [from_id, to_id, content]);
    const userRes = await pool.query('SELECT username, name, avatar FROM users WHERE id = $1', [from_id]);
    const sender = userRes.rows[0];
    io.to(`user_${to_id}`).emit('new_message', { from_id, content, date: Date.now(), from_username: sender.username, from_name: sender.name, from_avatar: sender.avatar });
    res.json({ success: true });
});

// === ОНЛАЙН ===
app.get('/api/online', async (req, res) => {
    const ids = Array.from(onlineUsers.values());
    if (ids.length === 0) return res.json([]);
    const ph = ids.map((_, i) => `$${i + 1}`).join(',');
    const r = await pool.query(`SELECT id, username, name, avatar FROM users WHERE id IN (${ph})`, ids);
    res.json(r.rows);
});

// === SOCKET.IO ===
io.on('connection', (socket) => {
    socket.on('join_user', async (userId) => {
        onlineUsers.set(socket.id, userId);
        socket.join(`user_${userId}`);
        const r = await pool.query('SELECT id, username, name, avatar FROM users WHERE id = $1', [userId]);
        if (r.rows.length > 0) io.emit('user_online', r.rows[0]);
    });
    socket.on('call_request', (d) => io.to(`user_${d.toId}`).emit('incoming_call', d));
    socket.on('call_accept', (d) => io.to(`user_${d.fromId}`).emit('call_accepted', d));
    socket.on('call_reject', (d) => io.to(`user_${d.fromId}`).emit('call_rejected', d));
    socket.on('call_end', (d) => io.to(`user_${d.toId}`).emit('call_ended', d));
    socket.on('call_busy', (d) => io.to(`user_${d.toId}`).emit('call_busy_signal', d));
    socket.on('webrtc_offer', (d) => io.to(`user_${d.toId}`).emit('webrtc_offer', d));
    socket.on('webrtc_answer', (d) => io.to(`user_${d.toId}`).emit('webrtc_answer', d));
    socket.on('webrtc_ice', (d) => io.to(`user_${d.toId}`).emit('webrtc_ice', d));
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

// === Админ при старте ===
setTimeout(async () => {
    try {
        const existing = await pool.query("SELECT id FROM users WHERE username = 'admin'");
        if (existing.rows.length === 0) {
            const hash = await bcrypt.hash('SuperAdmin2026!', 10);
            await pool.query("INSERT INTO users (username, name, password, avatar, bio, badge, badge_color, permissions) VALUES ('admin', 'Главный Админ', $1, '👑', 'Я слежу за порядком.', '👑 Админ', '#ff6b6b', '[\"delete_posts\",\"ban_users\",\"set_badges\",\"view_stats\"]')", [hash]);
            console.log('👑 Админ создан');
        }
    } catch(e) { console.error('⚠️ Админ:', e.message); }
}, 3000);

app.get('/ping', (req, res) => res.json({ status: 'alive' }));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`✅ Server on port ${PORT}`));
