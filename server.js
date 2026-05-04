const express = require("express");
const mysql = require("mysql2/promise");

const app = express();
const PORT = process.env.PORT || 3000;

const dbConfig = {
  host: process.env.AIVEN_HOST,
  port: Number(process.env.AIVEN_PORT || 3306),
  user: process.env.AIVEN_USER,
  password: process.env.AIVEN_PASSWORD,
  database: process.env.AIVEN_DATABASE,
  ssl: {
    rejectUnauthorized: false
  }
};

app.get("/", function(req, res) {
  res.type("text/plain");
  res.send("API MoonLoader online");
});

app.get("/load", async function(req, res) {
  res.type("text/plain");

  let connection;

  try {
    connection = await mysql.createConnection(dbConfig);

    const [rows] = await connection.query("SELECT NOW() AS fecha_actual");

    res.send(
      "OK AIVEN MYSQL\n" +
      "Base usada: " + process.env.AIVEN_DATABASE + "\n" +
      "Fecha MySQL: " + rows[0].fecha_actual + "\n"
    );
  } catch (error) {
    res.send(
      "ERROR AIVEN MYSQL\n" +
      error.message + "\n"
    );
  } finally {
    if (connection) {
      await connection.end();
    }
  }
});

app.listen(PORT, function() {
  console.log("Servidor iniciado en puerto " + PORT);
});
