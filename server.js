import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { pool, connectDB } from "./db.js";
import webhookRouter from "./webhook.js";   // ✅ ADDED

dotenv.config();

const app = express();

// Allowed frontend domain
const API_BASE_URL = "https://aiagent-frontend.zasya.online/";

app.use(
  cors({
    origin: API_BASE_URL,
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());

// ✅ REGISTER WEBHOOK ROUTE
app.use("/webhook", webhookRouter);

/* -----------------------------------------
   CONSTANTS
--------------------------------------------*/
const SERVICE_PRICES = {
  Haircut: 300,
  Facial: 400,
  Shave: 150,
  "Hair coloring": 500,
  Manicure: 350,
};

const BRANCHES = {
  1: "Miyapur",
  2: "Madhapur",
  3: "Jubilee Hills",
  4: "Banjara Hills",
};

function greetUser() {
  const hr = new Date().getHours();
  if (hr < 12) return "Good Morning";
  if (hr < 18) return "Good Afternoon";
  return "Good Evening";
}

function respond(reply, nextStep, extra = {}) {
  return { reply, nextStep, ...extra };
}

function calculateTotal(services) {
  return services.reduce((sum, s) => sum + (SERVICE_PRICES[s] || 0), 0);
}

/* -----------------------------------------
   DATE/TIME HELPERS
--------------------------------------------*/
function parseDate(input) {
  const t = input.trim();
  let parts;

  if (/^\d{2}-\d{2}-\d{4}$/.test(t)) {
    parts = t.split("-").map(Number);
    return new Date(parts[2], parts[1] - 1, parts[0]);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    parts = t.split("-").map(Number);
    return new Date(parts[0], parts[1] - 1, parts[2]);
  }

  return null;
}

function formatTime(hour24) {
  let h = hour24;
  const ampm = h >= 12 ? "PM" : "AM";
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}${ampm}`;
}

function generateTimeButtons() {
  return Array.from({ length: 13 }, (_, i) => {
    const hr = i + 10;
    return { text: formatTime(hr), value: formatTime(hr) };
  });
}

/* -----------------------------------------
   MAIN CHATBOT ROUTE
--------------------------------------------*/
app.post("/api/chat", async (req, res) => {
  try {
    let { text, step, phone, tempBooking } = req.body;

    text = (text || "").trim();
    step = step || "phone";

    tempBooking = tempBooking || {};
    tempBooking.services = tempBooking.services || [];

    /* ------------------------------
       PHONE LOGIN
    -------------------------------*/
    if (step === "phone") {
      const digits = text.replace(/\D/g, "");
      if (digits.length !== 10)
        return res.json(respond("📱 Enter your 10-digit phone number:", "phone"));

      phone = digits;

      const result = await pool.query(
        "SELECT * FROM salon_users WHERE phone=$1",
        [phone]
      );

      const greet = greetUser();

      if (result.rows.length > 0) {
        return res.json(
          respond(`${greet} ${result.rows[0].name}! 👋`, "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Appointment", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Reschedule / Cancel", value: "modify" },
            ],
          })
        );
      }

      return res.json(
        respond("You're new! What's your name?", "newUserName", { phone })
      );
    }

    /* ------------------------------
       NEW USER NAME
    -------------------------------*/
    if (step === "newUserName") {
      const name = text;

      await pool.query(
        "INSERT INTO salon_users (phone, name) VALUES ($1,$2)",
        [phone, name]
      );

      return res.json(
        respond(
          `🎉 Welcome ${name}! You get 50% OFF on your first service.`,
          "mainMenu",
          {
            phone,
            buttons: [
              { text: "📅 Book Appointment", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Reschedule / Cancel", value: "modify" },
            ],
          }
        )
      );
    }

    /* ------------------------------
       MAIN MENU
    -------------------------------*/
    if (step === "mainMenu") {
      if (text === "book") {
        tempBooking = { mode: "new", services: [] };
        return res.json(
          respond("Select services:", "bookService", {
            phone,
            tempBooking,
            buttons: [
              { text: "Haircut", value: "Haircut" },
              { text: "Facial", value: "Facial" },
              { text: "Shave", value: "Shave" },
              { text: "Hair coloring", value: "Hair coloring" },
              { text: "Manicure", value: "Manicure" },
              { text: "Done", value: "__done_services__" },
            ],
          })
        );
      }

      if (text === "view") {
        const result = await pool.query(
          `SELECT * FROM appointments 
           WHERE customer_phone=$1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length)
          return res.json(
            respond("📭 You have no appointments.", "mainMenu", { phone })
          );

        const formatted = result.rows.map((a, i) =>
          `${i + 1}) ${a.services} at ${a.location} on ${
            a.appointment_date.toISOString().split("T")[0]
          } ${a.appointment_time} — ₹${a.total_price}`
        );

        return res.json(
          respond(`📋 Your Appointments:\n\n${formatted.join("\n")}`, "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Another", value: "book" },
              { text: "🛠 Reschedule / Cancel", value: "modify" },
            ],
          })
        );
      }

      if (text === "modify") {
        const result = await pool.query(
          `SELECT * FROM appointments 
           WHERE customer_phone=$1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length)
          return res.json(
            respond("📭 No appointments to modify.", "mainMenu", { phone })
          );

        return res.json(
          respond("Select appointment to modify:", "modifyPick", {
            phone,
            appointments: result.rows,
            buttons: result.rows.map((a, i) => ({
              text: `${i + 1}) ${a.services} (${a.location})`,
              value: String(i + 1),
            })),
          })
        );
      }

      return res.json(respond("Choose a valid option.", "mainMenu"));
    }

    /* ------------------------------
       MODIFY PICK
    -------------------------------*/
    if (step === "modifyPick") {
      const result = await pool.query(
        `SELECT * FROM appointments WHERE customer_phone=$1`,
        [phone]
      );

      const idx = Number(text) - 1;
      if (idx < 0 || idx >= result.rows.length)
        return res.json(
          respond("❌ Invalid choice.", "modifyPick", { phone })
        );

      const a = result.rows[idx];

      tempBooking = {
        mode: "modify",
        appointmentId: a.appointment_id,
        services: a.services.split(", "),
        location: a.location,
        dateISO: a.appointment_date.toISOString().split("T")[0],
        timeLabel: a.appointment_time,
        totalPrice: a.total_price,
      };

      return res.json(
        respond("What would you like to modify?", "modifyMenu", {
          phone,
          tempBooking,
          buttons: [
            { text: "✂ Change Services", value: "1" },
            { text: "📍 Change Branch", value: "2" },
            { text: "📆 Change Date", value: "3" },
            { text: "⏰ Change Time", value: "4" },
            { text: "🔄 Change All", value: "5" },
            { text: "❌ Cancel Appointment", value: "6" },
            { text: "⬅ Back", value: "7" },
          ],
        })
      );
    }

    /* ------------------------------
       MODIFY MENU
    -------------------------------*/
    if (step === "modifyMenu") {
      switch (text) {
        case "1":
          tempBooking.modifyType = "services";
          return res.json(
            respond("Select new services:", "bookService", {
              phone,
              tempBooking,
              buttons: [
                { text: "Haircut", value: "Haircut" },
                { text: "Facial", value: "Facial" },
                { text: "Shave", value: "Shave" },
                { text: "Hair coloring", value: "Hair coloring" },
                { text: "Manicure", value: "Manicure" },
                { text: "Done", value: "__done_services__" },
              ],
            })
          );

        case "2":
          tempBooking.modifyType = "branch";
          return res.json(
            respond("Choose new branch:", "bookBranch", {
              phone,
              tempBooking,
              buttons: Object.entries(BRANCHES).map(([n, name]) => ({
                text: name,
                value: n,
              })),
            })
          );

        case "3":
          tempBooking.modifyType = "date";
          return res.json(
            respond("Select new date:", "bookDate", { phone, tempBooking })
          );

        case "4":
          tempBooking.modifyType = "time";
          return res.json(
            respond("Select new time:", "bookTime", {
              phone,
              tempBooking,
              buttons: generateTimeButtons(),
            })
          );

        case "5":
          tempBooking.modifyType = "all";
          return res.json(
            respond("Select new services:", "bookService", {
              phone,
              tempBooking,
              buttons: [
                { text: "Haircut", value: "Haircut" },
                { text: "Facial", value: "Facial" },
                { text: "Shave", value: "Shave" },
                { text: "Hair coloring", value: "Hair coloring" },
                { text: "Manicure", value: "Manicure" },
                { text: "Done", value: "__done_services__" },
              ],
            })
          );

        case "6":
          await pool.query(
            "DELETE FROM appointments WHERE appointment_id=$1",
            [tempBooking.appointmentId]
          );
          return res.json(
            respond("❌ Appointment Cancelled.", "mainMenu", {
              phone,
              buttons: [
                { text: "📅 Book Appointment", value: "book" },
                { text: "👀 View Appointments", value: "view" },
              ],
            })
          );

        case "7":
          return res.json(
            respond("Back to menu.", "mainMenu", {
              phone,
              buttons: [
                { text: "📅 Book Appointment", value: "book" },
                { text: "👀 View Appointments", value: "view" },
                { text: "🛠 Reschedule / Cancel", value: "modify" },
              ],
            })
          );

        default:
          return res.json(
            respond("Select a valid option.", "modifyMenu")
          );
      }
    }

    /* ------------------------------
       SERVICE SELECTION
    -------------------------------*/
    if (step === "bookService") {
      if (text === "__done_services__") {
        if (!tempBooking.services.length)
          return res.json(
            respond("❌ Select at least one.", "bookService", {
              phone,
              tempBooking,
            })
          );

        tempBooking.totalPrice = calculateTotal(tempBooking.services);

        if (tempBooking.mode === "modify" &&
            tempBooking.modifyType === "services") {
          await pool.query(
            `UPDATE appointments 
             SET services=$1, total_price=$2 
             WHERE appointment_id=$3`,
            [
              tempBooking.services.join(", "),
              tempBooking.totalPrice,
              tempBooking.appointmentId,
            ]
          );

          return res.json(
            respond("✔ Services updated!", "mainMenu", {
              phone,
              buttons: [
                { text: "📅 Book Another", value: "book" },
                { text: "👀 View Appointments", value: "view" },
                { text: "🛠 Modify Again", value: "modify" },
              ],
            })
          );
        }

        return res.json(
          respond("Choose branch:", "bookBranch", {
            phone,
            tempBooking,
            buttons: Object.entries(BRANCHES).map(([n, name]) => ({
              text: name,
              value: n,
            })),
          })
        );
      }

      const valid = SERVICE_PRICES[text];
      if (!valid)
        return res.json(
          respond("Tap a valid service.", "bookService", {
            phone,
            tempBooking,
          })
        );

      const idx = tempBooking.services.indexOf(text);
      if (idx === -1) tempBooking.services.push(text);
      else tempBooking.services.splice(idx, 1);

      return res.json(
        respond(`Selected: ${tempBooking.services.join(", ")}`, "bookService", {
          phone,
          tempBooking,
        })
      );
    }

    /* ------------------------------
       BRANCH
    -------------------------------*/
    if (step === "bookBranch") {
      const branch = BRANCHES[Number(text)];
      if (!branch)
        return res.json(
          respond("Invalid branch.", "bookBranch", { phone, tempBooking })
        );

      tempBooking.location = branch;

      if (tempBooking.mode === "modify" &&
          tempBooking.modifyType === "branch") {
        await pool.query(
          `UPDATE appointments SET location=$1 WHERE appointment_id=$2`,
          [branch, tempBooking.appointmentId]
        );

        return res.json(
          respond("✔ Branch updated!", "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Another", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Modify Again", value: "modify" },
            ],
          })
        );
      }

      return res.json(
        respond("📆 Select date:", "bookDate", { phone, tempBooking })
      );
    }

    /* ------------------------------
       DATE
    -------------------------------*/
    if (step === "bookDate") {
      const d = parseDate(text);
      if (!d)
        return res.json(
          respond("❌ Invalid date.", "bookDate", { phone, tempBooking })
        );

      tempBooking.dateISO = d.toISOString().split("T")[0];

      if (tempBooking.mode === "modify" &&
          tempBooking.modifyType === "date") {
        await pool.query(
          `UPDATE appointments SET appointment_date=$1 WHERE appointment_id=$2`,
          [tempBooking.dateISO, tempBooking.appointmentId]
        );

        return res.json(
          respond("✔ Date updated!", "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Another", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Modify Again", value: "modify" },
            ],
          })
        );
      }

      return res.json(
        respond("⏰ Select time:", "bookTime", {
          phone,
          tempBooking,
          buttons: generateTimeButtons(),
        })
      );
    }

    /* ------------------------------
       TIME
    -------------------------------*/
    if (step === "bookTime") {
      const validTimes = generateTimeButtons().map((t) => t.value);

      if (!validTimes.includes(text))
        return res.json(
          respond("❌ Select valid time.", "bookTime", {
            phone,
            tempBooking,
            buttons: generateTimeButtons(),
          })
        );

      const timeLabel = text;

      if (tempBooking.mode === "modify" &&
          tempBooking.modifyType === "time") {
        await pool.query(
          `UPDATE appointments 
           SET appointment_time=$1 
           WHERE appointment_id=$2`,
          [timeLabel, tempBooking.appointmentId]
        );

        return res.json(
          respond("✔ Time updated!", "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Another", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Modify Again", value: "modify" },
            ],
          })
        );
      }

      if (tempBooking.mode === "modify" &&
          tempBooking.modifyType === "all") {
        const { services, totalPrice, location, dateISO, appointmentId } =
          tempBooking;

        await pool.query(
          `UPDATE appointments
           SET services=$1, location=$2, appointment_date=$3, appointment_time=$4, total_price=$5
           WHERE appointment_id=$6`,
          [
            services.join(", "),
            location,
            dateISO,
            timeLabel,
            totalPrice,
            appointmentId,
          ]
        );

        return res.json(
          respond("✔ Appointment fully updated!", "mainMenu", {
            phone,
            buttons: [
              { text: "📅 Book Another", value: "book" },
              { text: "👀 View Appointments", value: "view" },
              { text: "🛠 Modify Again", value: "modify" },
            ],
          })
        );
      }

      const { services, totalPrice, location, dateISO } = tempBooking;

      await pool.query(
        `INSERT INTO appointments
         (customer_phone, services, location, appointment_date, appointment_time, total_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          phone,
          services.join(", "),
          location,
          dateISO,
          timeLabel,
          totalPrice,
          "booked",
        ]
      );

      return res.json(
        respond("🎉 Appointment Confirmed!", "mainMenu", {
          phone,
          buttons: [
            { text: "📅 Book Another", value: "book" },
            { text: "👀 View Appointments", value: "view" },
            { text: "🛠 Reschedule / Cancel", value: "modify" },
          ],
        })
      );
    }

    /* ------------------------------
       FALLBACK
    -------------------------------*/
    return res.json(
      respond("Let's start again! Enter phone number:", "phone")
    );
  } catch (err) {
    console.error("SERVER ERROR:", err);
    return res.status(500).json(respond("⚠ Server error.", "phone"));
  }
});

/* -----------------------------------------
   START SERVER
--------------------------------------------*/
await connectDB();

const PORT = 8011;

app.listen(PORT, () =>
  console.log(`🚀 Salon Bot API running on port ${PORT}`)
);
