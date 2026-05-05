const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

const pool = mysql.createPool({
  host: process.env.AIVEN_HOST,
  port: Number(process.env.AIVEN_PORT || 3306),
  user: process.env.AIVEN_USER,
  password: process.env.AIVEN_PASSWORD,
  database: process.env.AIVEN_DATABASE,
  waitForConnections: true,
  connectionLimit: Number(process.env.MYSQL_POOL_LIMIT || 15),
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  charset: "utf8mb4",
  ssl: { rejectUnauthorized: false }
});

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function cleanName(name) {
  name = String(name || "Jugador").trim().replace(/[^A-Za-z0-9_]/g, "");
  return name.length ? name.substring(0, 24) : "Jugador";
}

function cleanText(text, limit = 144) {
  text = String(text || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.substring(0, limit);
}

function handleFromName(name) {
  return cleanName(name).toLowerCase().replace(/_/g, "").substring(0, 32) || "jugador";
}

function social(action, data) {
  return { app: "social", action, data };
}

function ok(res, action, data) {
  return res.json(social(action, data));
}

function fail(res, message, code = 200) {
  return res.status(code).json(social("error", { message: String(message || "Error interno.") }));
}

async function querySafe(sql, params = [], fallback = []) {
  try {
    const [rows] = await pool.query(sql, params);
    return rows;
  } catch (e) {
    return fallback;
  }
}

async function withTx(fn) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

async function ensureUser(player, skin, conn = pool) {
  player = cleanName(player);
  skin = toInt(skin, 0);
  const t = nowUnix();

  const [rows] = await conn.query(
    `SELECT id, nombre_jugador, apodo, skin, es_admin, advertencias, dm_privacidad, tag_privacidad
     FROM ng_twitter_usuarios
     WHERE nombre_jugador = ?
     LIMIT 1`,
    [player]
  );

  if (rows.length) {
    await conn.query(
      `UPDATE ng_twitter_usuarios
       SET ultima_vez=?, ultimo_login=?, skin=?, actualizado_en=?
       WHERE id=?`,
      [t, t, skin, t, rows[0].id]
    );
    return { ...rows[0], skin };
  }

  const apodo = handleFromName(player);
  const [ins] = await conn.query(
    `INSERT INTO ng_twitter_usuarios
     (nombre_jugador, apodo, skin, fecha_registro, ultimo_login, ultima_vez, creado_en, actualizado_en)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [player, apodo, skin, t, t, t, t, t]
  );

  await conn.query(
    `INSERT INTO ng_twitter_notificaciones
     (para_usuario_id, de_usuario_id, para_nombre, de_nombre, contenido, publicacion_id, leido, creado_en)
     VALUES (?, ?, ?, ?, ?, -1, 0, ?)`,
    [ins.insertId, ins.insertId, player, player, "Bienvenido a Twitter IC.", t]
  );

  return {
    id: ins.insertId,
    nombre_jugador: player,
    apodo,
    skin,
    es_admin: 0,
    advertencias: 0,
    dm_privacidad: 0,
    tag_privacidad: 0
  };
}

async function getPostRows({ lastId = 0, sinceId = 0, limit = 10, ids = [] }) {
  const params = [];
  let where = "WHERE eliminado=0";

  if (Array.isArray(ids) && ids.length) {
    const cleanIds = ids.map(v => toInt(v, 0)).filter(v => v > 0).slice(0, 50);
    if (!cleanIds.length) return [];
    where += ` AND id IN (${cleanIds.map(() => "?").join(",")})`;
    params.push(...cleanIds);
  } else if (sinceId > 0) {
    where += " AND id > ?";
    params.push(sinceId);
  } else if (lastId > 0) {
    where += " AND id < ?";
    params.push(lastId);
  }

  params.push(limit);
  const [rows] = await pool.query(
    `SELECT id, usuario_id, autor_nombre, autor_skin, contenido, likes_total, comentarios_total,
            creado_en, respuesta_id, respuesta_autor, respuesta_texto
     FROM ng_twitter_publicaciones
     ${where}
     ORDER BY id DESC
     LIMIT ?`,
    params
  );
  return rows;
}

async function buildPosts(rows, viewerId) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const ids = rows.map(r => r.id);
  const placeholders = ids.map(() => "?").join(",");

  const [comments] = await pool.query(
    `SELECT id, publicacion_id, usuario_id AS author_id, autor_nombre AS author, autor_skin AS skin,
            contenido AS text, creado_en AS time
     FROM ng_twitter_comentarios
     WHERE eliminado=0 AND publicacion_id IN (${placeholders})
     ORDER BY id ASC`,
    ids
  );

  const [likeCounts] = await pool.query(
    `SELECT publicacion_id, COUNT(DISTINCT usuario_id) AS total
     FROM ng_twitter_likes_publicaciones
     WHERE publicacion_id IN (${placeholders})
     GROUP BY publicacion_id`,
    ids
  );

  const [viewerLikes] = viewerId
    ? await pool.query(
        `SELECT publicacion_id
         FROM ng_twitter_likes_publicaciones
         WHERE usuario_id=? AND publicacion_id IN (${placeholders})
         GROUP BY publicacion_id`,
        [viewerId, ...ids]
      )
    : [[]];

  const [likers] = await pool.query(
    `SELECT publicacion_id, nombre_jugador AS name, MAX(creado_en) AS time
     FROM ng_twitter_likes_publicaciones
     WHERE publicacion_id IN (${placeholders})
     GROUP BY publicacion_id, nombre_jugador
     ORDER BY time DESC`,
    ids
  );

  const commentsByPost = new Map();
  for (const c of comments) {
    if (!commentsByPost.has(c.publicacion_id)) commentsByPost.set(c.publicacion_id, []);
    const list = commentsByPost.get(c.publicacion_id);
    if (list.length < 25) list.push(c);
  }

  const countByPost = new Map(likeCounts.map(r => [r.publicacion_id, toInt(r.total, 0)]));
  const likedSet = new Set(viewerLikes.map(r => r.publicacion_id));
  const likersByPost = new Map();
  for (const l of likers) {
    if (!likersByPost.has(l.publicacion_id)) likersByPost.set(l.publicacion_id, []);
    const list = likersByPost.get(l.publicacion_id);
    if (list.length < 8) list.push({ name: l.name });
  }

  return rows.map(row => {
    const commentList = commentsByPost.get(row.id) || [];
    const likes = countByPost.get(row.id) ?? toInt(row.likes_total, 0);
    return {
      id: row.id,
      post_id: row.id,
      author_id: row.usuario_id || -1,
      author: row.autor_nombre,
      skin: row.autor_skin || 0,
      text: row.contenido,
      likes,
      liked: likedSet.has(row.id),
      comments_total: toInt(row.comentarios_total, commentList.length),
      comments: commentList,
      likers: likersByPost.get(row.id) || [],
      time: row.creado_en || 0,
      reply_id: row.respuesta_id ?? -1,
      reply_author: row.respuesta_autor || "",
      reply_text: row.respuesta_texto || ""
    };
  });
}

async function buildSinglePost(postId, viewerId) {
  const rows = await getPostRows({ ids: [postId], limit: 1 });
  const posts = await buildPosts(rows, viewerId);
  return posts[0] || null;
}

async function createNotification(toUserId, fromUser, content, postId = -1, conn = pool) {
  if (!toUserId || toUserId <= 0 || toUserId === fromUser.id) return;
  await conn.query(
    `INSERT INTO ng_twitter_notificaciones
     (para_usuario_id, de_usuario_id, para_nombre, de_nombre, contenido, publicacion_id, leido, creado_en)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    [toUserId, fromUser.id, "", fromUser.nombre_jugador, cleanText(content, 180), postId, nowUnix()]
  );
}

app.get("/", (req, res) => res.type("text/plain").send("Twitter IC API online - rework 1.12-fix"));

app.get("/load", async (req, res) => {
  res.type("text/plain");
  try {
    const [rows] = await pool.query("SELECT NOW() AS fecha_actual");
    res.send(
      "OK AIVEN MYSQL\n" +
      "API: Twitter IC rework 1.12-fix\n" +
      "Base usada: " + process.env.AIVEN_DATABASE + "\n" +
      "Fecha MySQL: " + rows[0].fecha_actual + "\n"
    );
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
      `SELECT id, de_usuario_id AS from_id, de_nombre AS \`from\`, contenido AS text,
              publicacion_id AS post_id, leido AS \`read\`, creado_en AS time
       FROM ng_twitter_notificaciones
       WHERE para_usuario_id=?
       ORDER BY id DESC
       LIMIT 30`,
      [user.id]
    );

    const onlineSince = nowUnix() - 600;
    const [online] = await pool.query(
      `SELECT id, id AS db_id, nombre_jugador AS name, skin, es_admin AS is_admin,
              advertencias AS warnings, IF(ultima_vez >= ?, 1, 0) AS online
       FROM ng_twitter_usuarios
       ORDER BY ultima_vez DESC
       LIMIT 50`,
      [onlineSince]
    );

    const messages = await querySafe(
      `SELECT id, de_usuario_id AS from_id, para_usuario_id AS to_id, de_nombre AS \`from\`, para_nombre AS \`to\`,
              contenido AS text, leido AS \`read\`, creado_en AS time
       FROM ng_twitter_dms
       WHERE de_usuario_id=? OR para_usuario_id=?
       ORDER BY id DESC
       LIMIT 80`,
      [user.id, user.id],
      []
    );

    ok(res, "social_state", {
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
      messages: messages.map(m => ({ ...m, read: !!m.read })),
      online: online.map(u => ({ ...u, is_admin: !!u.is_admin, online: !!u.online })),
      following: [],
      admin_reports: []
    });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/feed", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const lastId = toInt(req.query.last_id, 0);
    const sinceId = toInt(req.query.since_id, 0);
    const limit = Math.min(Math.max(toInt(req.query.limit, 10), 1), 25);
    const append = String(req.query.append || "0") === "1" || String(req.query.append || "") === "true";

    const rows = await getPostRows({ lastId, sinceId, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const posts = await buildPosts(pageRows, user.id);
    const oldest = posts.reduce((m, p) => p.id > 0 && (m === 0 || p.id < m) ? p.id : m, 0);
    const latest = posts.reduce((m, p) => p.id > m ? p.id : m, 0);

    ok(res, "feed_update", {
      posts,
      replace: !append && sinceId <= 0,
      append: append || lastId > 0,
      has_more: hasMore,
      last_id: oldest,
      latest_id: latest,
      server_time: nowUnix()
    });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/post", async (req, res) => {
  try {
    const result = await withTx(async conn => {
      const user = await ensureUser(req.query.player, req.query.skin, conn);
      const text = cleanText(req.query.text, 144);
      if (!text) throw new Error("Texto vacio.");

      const t = nowUnix();
      const replyId = toInt(req.query.reply_id, -1);
      const replyAuthor = cleanText(req.query.reply_author || "", 24);
      const replyText = cleanText(req.query.reply_text || "", 80);

      const [recent] = await conn.query(
        `SELECT id
         FROM ng_twitter_publicaciones
         WHERE usuario_id=? AND contenido=? AND eliminado=0 AND creado_en>=?
         ORDER BY id DESC
         LIMIT 1`,
        [user.id, text, t - 4]
      );

      if (recent.length) return { user, postId: recent[0].id, deduped: true };

      const [ins] = await conn.query(
        `INSERT INTO ng_twitter_publicaciones
         (usuario_id, autor_nombre, autor_skin, contenido, likes_total, comentarios_total, eliminado,
          creado_en, actualizado_en, respuesta_id, respuesta_autor, respuesta_texto)
         VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?, ?)`,
        [user.id, user.nombre_jugador, user.skin || 0, text, t, t, replyId, replyAuthor, replyText]
      );

      if (replyId > 0) {
        const [owner] = await conn.query(
          "SELECT usuario_id FROM ng_twitter_publicaciones WHERE id=? LIMIT 1",
          [replyId]
        );
        if (owner.length) {
          await createNotification(owner[0].usuario_id, user, `${user.nombre_jugador} respondio tu tweet.`, replyId, conn);
        }
      }

      return { user, postId: ins.insertId, deduped: false };
    });

    const post = await buildSinglePost(result.postId, result.user.id);
    ok(res, "post_update", { post, deduped: result.deduped, server_time: nowUnix() });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/like", async (req, res) => {
  try {
    const result = await withTx(async conn => {
      const user = await ensureUser(req.query.player, req.query.skin, conn);
      const postId = toInt(req.query.post_id, 0);
      if (postId <= 0) throw new Error("Post invalido.");

      const [postRows] = await conn.query(
        "SELECT id, usuario_id FROM ng_twitter_publicaciones WHERE id=? AND eliminado=0 LIMIT 1 FOR UPDATE",
        [postId]
      );
      if (!postRows.length) throw new Error("Ese tweet no existe.");

      const [exists] = await conn.query(
        "SELECT 1 FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? AND usuario_id=? LIMIT 1",
        [postId, user.id]
      );

      let liked;
      if (exists.length) {
        await conn.query(
          "DELETE FROM ng_twitter_likes_publicaciones WHERE publicacion_id=? AND usuario_id=?",
          [postId, user.id]
        );
        liked = false;
      } else {
        await conn.query(
          "INSERT INTO ng_twitter_likes_publicaciones (publicacion_id, usuario_id, nombre_jugador, creado_en) VALUES (?, ?, ?, ?)",
          [postId, user.id, user.nombre_jugador, nowUnix()]
        );
        liked = true;
        await createNotification(postRows[0].usuario_id, user, `${user.nombre_jugador} le dio me gusta a tu tweet.`, postId, conn);
      }

      const [[c]] = await conn.query(
        "SELECT COUNT(DISTINCT usuario_id) AS total FROM ng_twitter_likes_publicaciones WHERE publicacion_id=?",
        [postId]
      );
      await conn.query(
        "UPDATE ng_twitter_publicaciones SET likes_total=?, actualizado_en=? WHERE id=?",
        [c.total || 0, nowUnix(), postId]
      );
      return { user, postId, liked };
    });

    const post = await buildSinglePost(result.postId, result.user.id);
    if (post) post.liked = result.liked;
    ok(res, "post_update", { post, activity: { post_id: result.postId, likes: post ? post.likes : 0, liked: result.liked } });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/comment", async (req, res) => {
  try {
    const result = await withTx(async conn => {
      const user = await ensureUser(req.query.player, req.query.skin, conn);
      const postId = toInt(req.query.post_id, 0);
      const text = cleanText(req.query.text, 144);
      if (postId <= 0 || !text) throw new Error("Comentario invalido.");

      const [postRows] = await conn.query(
        "SELECT id, usuario_id FROM ng_twitter_publicaciones WHERE id=? AND eliminado=0 LIMIT 1 FOR UPDATE",
        [postId]
      );
      if (!postRows.length) throw new Error("Ese tweet no existe.");

      const t = nowUnix();
      const [recent] = await conn.query(
        `SELECT id
         FROM ng_twitter_comentarios
         WHERE publicacion_id=? AND usuario_id=? AND contenido=? AND eliminado=0 AND creado_en>=?
         LIMIT 1`,
        [postId, user.id, text, t - 4]
      );

      if (!recent.length) {
        await conn.query(
          `INSERT INTO ng_twitter_comentarios
           (publicacion_id, usuario_id, autor_nombre, autor_skin, contenido, eliminado, creado_en, actualizado_en)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?)`,
          [postId, user.id, user.nombre_jugador, user.skin || 0, text, t, t]
        );
        await createNotification(postRows[0].usuario_id, user, `${user.nombre_jugador} comento tu tweet.`, postId, conn);
      }

      const [[c]] = await conn.query(
        "SELECT COUNT(*) AS total FROM ng_twitter_comentarios WHERE publicacion_id=? AND eliminado=0",
        [postId]
      );
      await conn.query(
        "UPDATE ng_twitter_publicaciones SET comentarios_total=?, actualizado_en=? WHERE id=?",
        [c.total || 0, t, postId]
      );

      return { user, postId };
    });

    const post = await buildSinglePost(result.postId, result.user.id);
    ok(res, "post_update", { post, activity: { post_id: result.postId, comments: post ? post.comments_total : 0 } });
  } catch (e) {
    fail(res, e.message);
  }
});


app.get("/api/notifications/read", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    await pool.query(
      "UPDATE ng_twitter_notificaciones SET leido=1 WHERE para_usuario_id=? AND leido=0",
      [user.id]
    );
    ok(res, "notifications_marked", { unread_notifs: 0, server_time: nowUnix() });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/dms/read", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    await pool.query(
      "UPDATE ng_twitter_dms SET leido=1 WHERE para_usuario_id=? AND leido=0",
      [user.id]
    );
    ok(res, "dms_marked", { unread_dms: 0, server_time: nowUnix() });
  } catch (e) {
    fail(res, e.message);
  }
});

app.get("/api/privacy", async (req, res) => {
  try {
    const user = await ensureUser(req.query.player, req.query.skin);
    const kind = String(req.query.kind || "").toLowerCase();
    const value = Math.min(Math.max(toInt(req.query.value, 0), 0), 3);

    if (kind !== "dm" && kind !== "tag") {
      return fail(res, "Tipo de privacidad invalido.");
    }

    const column = kind === "dm" ? "dm_privacidad" : "tag_privacidad";
    await pool.query(
      `UPDATE ng_twitter_usuarios SET ${column}=?, actualizado_en=? WHERE id=?`,
      [value, nowUnix(), user.id]
    );

    const [[fresh]] = await pool.query(
      "SELECT dm_privacidad, tag_privacidad FROM ng_twitter_usuarios WHERE id=? LIMIT 1",
      [user.id]
    );

    ok(res, "privacy_updated", {
      dm_privacy: fresh ? (fresh.dm_privacidad || 0) : 0,
      tag_privacy: fresh ? (fresh.tag_privacidad || 0) : 0,
      server_time: nowUnix()
    });
  } catch (e) {
    fail(res, e.message);
  }
});


process.on("unhandledRejection", err => {
  console.error("Unhandled rejection:", err);
});

app.listen(PORT, () => console.log("Twitter IC API rework 1.12-fix iniciado en puerto " + PORT));