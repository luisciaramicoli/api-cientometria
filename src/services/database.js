const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");

const saltRounds = 10;

// TiDB connection details from environment variables
const pool = mysql.createPool({
  host: process.env.TIDB_HOST || "gateway01.us-east-1.prod.aws.tidbcloud.com",
  user: process.env.TIDB_USER || "bW63nyscFV7wYZr.root",
  password: process.env.TIDB_PASSWORD || "mDTgW12h01Z15tnA",
  database: process.env.TIDB_DATABASE || "Curadoria",
  port: process.env.TIDB_PORT || 4000, // Default TiDB port
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  ssl: {
    rejectUnauthorized: true,
  },
});

const initDb = async () => {
  console.log("Attempting to connect to TiDB and initialize database...");
  let connection;
  try {
    connection = await pool.getConnection();

    // Create the users table if it doesn't exist
    const createTableSql = `
            CREATE TABLE IF NOT EXISTS users (
                id BIGINT AUTO_RANDOM PRIMARY KEY,
                username VARCHAR(50) NOT NULL UNIQUE,
                email VARCHAR(255) NOT NULL UNIQUE,
                password_hash VARCHAR(60) NOT NULL,
                role ENUM('admin', 'cientometria', 'curadoria_boaretto', 'curadoria_bonetti') NOT NULL DEFAULT 'cientometria',
                is_active BOOLEAN DEFAULT TRUE,
                created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            );
        `;
    await connection.execute(createTableSql);
    console.log("Table 'users' checked/created successfully in TiDB.");

    // Admin user details (can be configured via environment variables)
    const adminUsername = process.env.ADMIN_USERNAME || "admin";
    const adminPassword = process.env.ADMIN_PASSWORD || "password123";
    const adminEmail = process.env.ADMIN_EMAIL || "admin@example.com";
    const adminRole = "admin";

    // Check if the admin user already exists
    const [rows] = await connection.execute(
      "SELECT * FROM users WHERE username = ?",
      [adminUsername],
    );

    if (rows.length === 0) {
      console.log(`Admin user '${adminUsername}' not found, creating...`);
      const hash = await bcrypt.hash(adminPassword, saltRounds);
      await connection.execute(
        "INSERT INTO users (username, email, password_hash, role) VALUES (?, ?, ?, ?)",
        [adminUsername, adminEmail, hash, adminRole],
      );
      console.log(`Admin user '${adminUsername}' created successfully.`);
    } else {
      console.log(`Admin user '${adminUsername}' already exists.`);
    }
  } catch (err) {
    console.error("Error initializing TiDB database:", err.message);
    // In a real application, you might want to exit or handle this more gracefully
  } finally {
    if (connection) connection.release();
  }
};

module.exports = { pool, initDb, saltRounds };
