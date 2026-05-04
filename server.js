const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

const pool = mysql.createPool({
  host: process.env.AIVEN_HOST,
  port: Number(process.env.AIVEN_PORT || 3306),
  user: process.env.AIVEN_USER,
  password: process.env.AIVEN_PASSWORD,
  database: process.env.AIVEN_DATABASE,
  waitForConnections: true,
  connectionLimit: 5,
  charset: "utf8mb4",
  ssl: { rejectUnauthorized: false }
});

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function cleanName(name) {
  name = String(name || "Jugador").trim().replace(/[^A-Za-z0-9_]/g, "");
  return name.length ? name.substring(0, 24) : "Jugador";
}

function cleanText(text, limit) {
  text = String(text || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  return text.substring(0, limit || 144);
}

function handleFromName(name) {
  return cleanName(name).toLowerCase().replace(/_/g, "").substring(0, 32) || "jugador";
}

function social(action, data) {
  return { app: "social", action, data };
}

async function ensureUser(player, skin) {
  player = cleanName(player);
  skin = Number(skin || 0) || 0;
  const t = nowUnix();
  const [rows] = await pool.query(
    "SELECT id, nombre_jugador, apodo, skin, es_admin, advertencias, dm_privacidad, tag_privacidad FROM ng_twitter_usuarios WHERE nombre_jugador = ? LIMIT 1",
    [player]
  );
  if (rows.length) {
    await pool.query(
      "UPDATE ng_twitter_usuarios SET ultima_vez=?, ultimo_login=?, skin=?, actualizado_en=? WHERE id=?",
      [t, t, skin, t, rows[0].id]
    );
    return { ...rows[0], skin };
  }
  const apodo = handleFromName(player);
  const [ins] = await pool.query(
    "INSERT INTO ng_twitter_usuarios (nombre_jugador, apodo, skin, fecha_registro, ultimo_login, ultima_vez, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [player, apodo, skin, t, t, t, t, t]
  );
  await pool.query(
    "INSERT INTO ng_twitter_notificaciones (para_usuario_id, de_usuario_id, para_nombre, de_nombre, contenido, publicacion_id, leido, creado_en) VALUES (?, ?, ?, ?, ?, -1, 0, ?)",
    [ins.insertId, ins.insertId, player, player, "Bienvenido a Twitter IC.", t]
  );
  return { id: ins.insertId, nombre_jugador: player, apodo, skin, es_admin: 0, advertencias: 0, dm_privacidad: 0, tag_privacidad: 0 };
}

async function buildPost(row, viewerId) {
  const [comments] = await pool.query(
    `SELECT id, usuario_id AS author_id, autor_nombre AS author, autor_skin AS skin, contenido AS text, creado_en AS time
     FROM ng_twitter_comentarios
     WHERE publicacion_id=? AND eliminado=0
     ORDER BY id ASC
     LIMIT 25`,
    [row.id]
  );
  let liked = false;
  if (viewerId) {
    const [likeRows] = await pool.query(
      "SELECT 1 FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? AND usuario_id=? LIMIT 1",
      [row.id, viewerId]
    );
    liked = likeRows.length > 0;
  }
  const [likers] = await pool.query(
    "SELECT nombre_jugador AS name FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? ORDER BY creado_en DESC LIMIT 8",
    [row.id]
  );
  return {
    id: row.id,
    post_id: row.id,
    author_id: row.usuario_id || -1,
    author: row.autor_nombre,
    skin: row.autor_skin || 0,
    text: row.contenido,
    likes: row.likes_total || 0,
    liked,
    comments_total: row.comentarios_total || comments.length,
    comments,
    likers,
    time: row.creado_en || 0,
    reply_id: row.respuesta_id ?? -1,
    reply_author: row.respuesta_autor || "",
    reply_text: row.respuesta_texto || ""
  };
}

app.get("/", (req, res) => res.type("text/plain").send("Twitter IC API online"));

app.get("/load", async (req, res) => {
  res.type("text/plain");
  try {
    const [rows] = await pool.query("SELECT NOW() AS fecha_actual");
    res.send("OK AIVEN MYSQL\nBase usada: " + process.env.AIVEN_DATABASE + "\nFecha MySQL: " + rows[0].fecha_actual + "\n");
  } catch (e) {
    res.send("ERROR AIVEN MYSQL\n" + e.message + "\n");
  }
});

app.get("/api/state", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const [[counts]] = await pool.query(
      `SELECT
        (SELECT COUNT(*) FROM ng_twitter_publicaciones WHERE usuario_id=? AND eliminado=0) AS posts,
        (SELECT COALESCE(SUM(likes_total),0) FROM ng_twitter_publicaciones WHERE usuario_id=? AND eliminado=0) AS likes,
        (SELECT COALESCE(SUM(comentarios_total),0) FROM ng_twitter_publicaciones WHERE usuario_id=? AND eliminado=0) AS comments,
        (SELECT COUNT(*) FROM ng_twitter_notificaciones WHERE para_usuario_id=? AND leido=0) AS unread_notifs,
        (SELECT COUNT(*) FROM ng_twitter_dms WHERE para_usuario_id=? AND leido=0) AS unread_dms`,
      [user.id, user.id, user.id, user.id, user.id]
    );
    const [notifications] = await pool.query(
      `SELECT id, de_usuario_id AS from_id, de_nombre AS \`from\`, contenido AS text, publicacion_id AS post_id, leido AS \`read\`, creado_en AS time
       FROM ng_twitter_notificaciones WHERE para_usuario_id=? ORDER BY id DESC LIMIT 30`,
      [user.id]
    );
    const [online] = await pool.query(
      `SELECT id, id AS db_id, nombre_jugador AS name, skin, es_admin AS is_admin, advertencias AS warnings, 1 AS online
       FROM ng_twitter_usuarios ORDER BY ultima_vez DESC LIMIT 50`
    );
    res.json(social("social_state", {
      profile: {
        id: user.id,
        db_id: user.id,
        name: user.nombre_jugador,
        skin: user.skin || 0,
        posts: counts.posts || 0,
        likes: counts.likes || 0,
        comments: counts.comments || 0,
        unread_notifs: counts.unread_notifs || 0,
        unread_dms: counts.unread_dms || 0,
        test_mode: false,
        is_admin: !!user.es_admin,
        warnings: user.advertencias || 0,
        mute_remaining: 0,
        mute_reason: "",
        dm_privacy: user.dm_privacidad || 0,
        tag_privacy: user.tag_privacidad || 0
      },
      notifications: notifications.map(n => ({ ...n, read: !!n.read })),
      messages: [],
      online: online.map(u => ({ ...u, is_admin: !!u.is_admin, online: true })),
      following: [],
      admin_reports: []
    }));
  } catch (e) {
    res.json(social("error", { message: e.message }));
  }
});

app.get("/api/feed", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const lastId = Number(req.query.last_id || 0) || 0;
    const limit = Math.min(Math.max(Number(req.query.limit || 10) || 10, 1), 25);
    const append = String(req.query.append || "0") === "1" || String(req.query.append || "") === "true";
    const params = [];
    let where = "WHERE eliminado=0";
    if (lastId > 0) {
      where += " AND id < ?";
      params.push(lastId);
    }
    params.push(limit + 1);
    const [rows] = await pool.query(
      `SELECT * FROM ng_twitter_publicaciones ${where} ORDER BY id DESC LIMIT ?`,
      params
    );
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const posts = [];
    for (const row of pageRows) posts.push(await buildPost(row, user.id));
    const oldest = posts.reduce((m, p) => p.id > 0 && (m === 0 || p.id < m) ? p.id : m, 0);
    res.json(social("feed_update", { posts, replace: !append, append, has_more: hasMore, last_id: oldest }));
  } catch (e) {
    res.json(social("error", { message: e.message }));
  }
});

app.get("/api/post", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const text = cleanText(req.query.text, 144);
    if (!text) return res.json(social("error", { message: "Texto vacio." }));
    const t = nowUnix();
    const replyId = Number(req.query.reply_id || -1) || -1;
    const replyAuthor = cleanText(req.query.reply_author || "", 24);
    const replyText = cleanText(req.query.reply_text || "", 80);
    const [ins] = await pool.query(
      `INSERT INTO ng_twitter_publicaciones
       (usuario_id, autor_nombre, autor_skin, contenido, likes_total, comentarios_total, eliminado, creado_en, actualizado_en, respuesta_id, respuesta_autor, respuesta_texto)
       VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
      [user.id, user.nombre_jugador, user.skin || 0, text, t, t, replyId, replyAuthor, replyText]
    );
    const [[row]] = await pool.query("SELECT * FROM ng_twitter_publicaciones WHERE id=?", [ins.insertId]);
    res.json(social("post_update", { post: await buildPost(row, user.id) }));
  } catch (e) {
    res.json(social("error", { message: e.message }));
  }
});

app.get("/api/like", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const postId = Number(req.query.post_id || 0) || 0;
    if (postId <= 0) return res.json(social("error", { message: "Post invalido." }));
    const [exists] = await pool.query("SELECT 1 FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? AND usuario_id=?", [postId, user.id]);
    if (exists.length) {
      await pool.query("DELETE FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? AND usuario_id=?", [postId, user.id]);
    } else {
      await pool.query("INSERT INTO ng_twitter_likes_publicaciones (publicacion_id, usuario_id, nombre_jugador, creado_en) VALUES (?, ?, ?, ?)", [postId, user.id, user.nombre_jugador, nowUnix()]);
    }
    const [[c]] = await pool.query("SELECT COUNT(*) AS total FROM ng_twitter_likes_publicaciones WHERE publicacion_id=?", [postId]);
    await pool.query("UPDATE ng_twitter_publicaciones SET likes_total=?, actualizado_en=? WHERE id=?", [c.total, nowUnix(), postId]);
    const [[row]] = await pool.query("SELECT * FROM ng_twitter_publicaciones WHERE id=?", [postId]);
    res.json(social("post_update", { post: await buildPost(row, user.id) }));
  } catch (e) {
    res.json(social("error", { message: e.message }));
  }
});

app.get("/api/comment", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const postId = Number(req.query.post_id || 0) || 0;
    const text = cleanText(req.query.text, 144);
    if (postId <= 0 || !text) return res.json(social("error", { message: "Comentario invalido." }));
    const t = nowUnix();
    await pool.query(
      "INSERT INTO ng_twitter_comentarios (publicacion_id, usuario_id, autor_nombre, autor_skin, contenido, eliminado, creado_en, actualizado_en) VALUES (?, ?, ?, ?, ?, 0, ?, ?)",
      [postId, user.id, user.nombre_jugador, user.skin || 0, text, t, t]
    );
    const [[c]] = await pool.query("SELECT COUNT(*) AS total FROM ng_twitter_comentarios WHERE publicacion_id=? AND eliminado=0", [postId]);
    await pool.query("UPDATE ng_twitter_publicaciones SET comentarios_total=?, actualizado_en=? WHERE id=?", [c.total, t, postId]);
    const [[row]] = await pool.query("SELECT * FROM ng_twitter_publicaciones WHERE id=?", [postId]);
    res.json(social("post_update", { post: await buildPost(row, user.id) }));
  } catch (e) {
    res.json(social("error", { message: e.message }));
  }
});

app.listen(PORT, () => console.log("Twitter IC API iniciado en puerto " + PORT));
