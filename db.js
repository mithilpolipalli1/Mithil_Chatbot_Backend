// db.js
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

export const pool = new pg.Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: false, // change to { rejectUnauthorized: false } if your server needs SSL
});

export async function connectDB() {
  try {
    await pool.query("SELECT 1");
    console.log("📌 Connected to PostgreSQL");
  } catch (err) {
    console.error("❌ Error connecting to PostgreSQL:", err);
    process.exit(1);
  }
}
