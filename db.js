// db.js
import { Pool } from "pg";

export const pool = new Pool({
  user: "postgres",
  host: "localhost",
  database: "postgres",
  password: "1234",          // ← change if your password is different
  port: 5432,
});

export async function connectDB() {
  try {
    await pool.connect();
    console.log("✅ Database connected");

    // Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS salon_users (
        phone VARCHAR(25) PRIMARY KEY,
        name  VARCHAR(100) NOT NULL,
        password_hash VARCHAR(255)
      );
    `);

    // Appointments table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS appointments (
        appointment_id   SERIAL PRIMARY KEY,
        services         TEXT,
        location         VARCHAR(100),
        appointment_date DATE,
        appointment_time VARCHAR(20),
        status           VARCHAR(20) DEFAULT 'booked',
        total_price      NUMERIC(10,2),
        customer_phone   VARCHAR(25) REFERENCES salon_users(phone)
      );
    `);
  } catch (err) {
    console.error("❌ DB error:", err);
    process.exit(1);
  }
}
