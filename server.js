// server.js
import express from "express";
import cors from "cors";
import axios from "axios";
import dotenv from "dotenv";
import { pool, connectDB } from "./db.js";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json());

/* ---------------------------------
   HELPERS & CONSTANTS
-----------------------------------*/

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

// All services with prices (names used everywhere)
const SERVICE_PRICES = {
  "Haircut": 300,
  "Facial": 400,
  "Shave": 150,
  "Hair coloring": 500,
  "Manicure": 350,
};

const BRANCHES = {
  1: "Miyapur",
  2: "Madhapur",
  3: "Jubilee Hills",
  4: "Banjara Hills",
};

// Main-menu choice parser
function parseMenuChoice(text) {
  const t = (text || "").toString().trim().toLowerCase();
  if (["1", "book", "book appointment"].includes(t)) return "book";
  if (["2", "view", "view appointments"].includes(t)) return "view";
  if (
    ["3", "modify", "modify appointment", "reschedule", "reschedule / cancel", "reschedule/cancel"]
      .includes(t)
  )
    return "modify";

  return null;
}

// Basic response helper
function makeReply(reply, nextStep, extra = {}) {
  return { reply, nextStep, ...extra };
}

// Restart chat loop
function restartSession(reply, phone) {
  return {
    reply:
      `${reply}\n\n🔁 Session restarted.\n\n👇 Choose what to do next:`,
    nextStep: "mainMenu",
    phone,
  };
}

// Parse DD-MM-YYYY within next 30 days
function parseDateDDMMYYYY(text) {
  const parts = text.trim().split(/[-/]/);
  if (parts.length !== 3) return null;

  const [dd, mm, yyyy] = parts.map(Number);
  const d = new Date(yyyy, mm - 1, dd);

  const valid =
    d.getFullYear() === yyyy &&
    d.getMonth() === mm - 1 &&
    d.getDate() === dd;

  if (!valid) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const max = new Date();
  max.setDate(max.getDate() + 30);
  d.setHours(0, 0, 0, 0);

  if (d < today || d > max) return null;

  return d;
}

// Parse time (10–22 allowed) like "4PM" or "16"
function parseTime(text) {
  if (!text) return null;
  let t = text.toString().trim().toUpperCase().replace(/\s+/g, "");

  // 4PM, 10AM, 12PM
  let match = t.match(/^(\d{1,2})(AM|PM)$/);
  if (match) {
    let h = Number(match[1]);
    const ampm = match[2];

    if (h < 1 || h > 12) return null;

    let hour24 = h;
    if (ampm === "PM" && h !== 12) hour24 += 12;
    if (ampm === "AM" && h === 12) hour24 = 0;

    if (hour24 < 10 || hour24 > 22) return null;

    const label = `${((hour24 + 11) % 12) + 1}${ampm}`;
    return { hour24, label };
  }

  // 16 (24h)
  match = t.match(/^(\d{1,2})$/);
  if (match) {
    const hour24 = Number(match[1]);
    if (hour24 < 10 || hour24 > 22) return null;

    const ampm = hour24 >= 12 ? "PM" : "AM";
    const hr12 = ((hour24 + 11) % 12) + 1;
    return { hour24, label: `${hr12}${ampm}` };
  }

  return null;
}

// Calculate total price from array of service names
function calculateTotalPrice(services = []) {
  return services.reduce(
    (sum, name) => sum + (SERVICE_PRICES[name] || 0),
    0
  );
}

/* ---------------------------------
   WEBSITE CHAT ENDPOINT (/chat)
   - This is what your frontend uses
-----------------------------------*/

app.post("/chat", async (req, res) => {
  try {
    let { text, step, phone, tempBooking } = req.body;

    text = (text || "").toString().trim();
    step = step || "phone";

    // tempBooking stores current booking/modify state
    tempBooking = tempBooking || {};
    tempBooking.services = tempBooking.services || [];

    /* STEP: phone (login / register) */
    if (step === "phone") {
      const digits = text.replace(/\D/g, "");
      if (digits.length !== 10) {
        return res.json(
          makeReply("Please enter a valid 10-digit phone number.", "phone")
        );
      }

      phone = digits;

      const result = await pool.query(
        "SELECT * FROM salon_users WHERE phone = $1",
        [phone]
      );

      if (result.rows.length > 0) {
        const user = result.rows[0];
        const greet = getGreeting();

        return res.json(
          makeReply(
            `${greet} ${user.name.toLowerCase()}! 👋\n👇 Choose an option below:`,
            "mainMenu",
            { phone }
          )
        );
      } else {
        return res.json(
          makeReply(
            "You're new here 🌟 What's your good name?",
            "newUserName",
            { phone }
          )
        );
      }
    }

    /* STEP: new user name */
    if (step === "newUserName") {
      const name = text || "Guest";

      await pool.query(
        "INSERT INTO salon_users (phone, name) VALUES ($1,$2) ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name",
        [phone, name]
      );

      const greet = getGreeting();

      return res.json(
        makeReply(
          `${greet} ${name.toLowerCase()}! 👋\n🎉 You get **50% OFF on your first service!**\n\n👇 Choose an option below:`,
          "mainMenu",
          { phone }
        )
      );
    }

    /* STEP: main menu */
    if (step === "mainMenu") {
      const choice = parseMenuChoice(text);

      if (!choice) {
        return res.json(
          makeReply("👇 Please choose an option below.", "mainMenu", { phone })
        );
      }

      // BOOK new appointment
      if (choice === "book") {
        tempBooking = {
          mode: "new",       // new | modify
          modifyType: null,  // services | branch | date | time | all
          services: [],
        };

        return res.json(
          makeReply(
            "Which services do you want?\n\nTap to select, then press Done ✅.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      // VIEW appointments
      if (choice === "view") {
        const result = await pool.query(
          `SELECT services, location, appointment_date, appointment_time, total_price, status
           FROM appointments
           WHERE customer_phone = $1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length) {
          return res.json(
            makeReply(
              "📭 You have no appointments yet.",
              "mainMenu",
              { phone }
            )
          );
        }

        const lines = result.rows.map((row, idx) => {
          const d = row.appointment_date.toISOString().split("T")[0];
          const price = row.total_price ? ` - ₹${row.total_price}` : "";
          return `${idx + 1}) ${row.services} at ${row.location} on ${d} ${
            row.appointment_time
          } (${row.status}${price})`;
        });

        return res.json(
          makeReply(
            `📋 Your appointments:\n\n${lines.join("\n")}`,
            "mainMenu",
            { phone }
          )
        );
      }

      // MODIFY / RESCHEDULE / CANCEL
      if (choice === "modify") {
        const result = await pool.query(
          `SELECT appointment_id, services, location, appointment_date, appointment_time, total_price
           FROM appointments
           WHERE customer_phone = $1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length) {
          return res.json(
            makeReply(
              "📭 You have no appointments to modify.",
              "mainMenu",
              { phone }
            )
          );
        }

        const lines = result.rows.map((row, idx) => {
          const d = row.appointment_date.toISOString().split("T")[0];
          const price = row.total_price ? ` - ₹${row.total_price}` : "";
          return `${idx + 1}) ${row.services} at ${row.location} on ${d} ${
            row.appointment_time
          }${price}`;
        });

        return res.json(
          makeReply(
            `🛠 Select an appointment to modify:\n\n${lines.join("\n")}`,
            "modifyPick",
            { phone }
          )
        );
      }
    }

    /* STEP: pick appointment to modify */
    if (step === "modifyPick") {
      const idx = Number(text) - 1;

      const result = await pool.query(
        `SELECT appointment_id, services, location, appointment_date, appointment_time, total_price
         FROM appointments
         WHERE customer_phone = $1
         ORDER BY appointment_date, appointment_time`,
        [phone]
      );

      if (Number.isNaN(idx) || idx < 0 || idx >= result.rows.length) {
        return res.json(
          makeReply("❌ Invalid number. Try again.", "modifyPick", { phone })
        );
      }

      const appt = result.rows[idx];

      tempBooking = {
        mode: "modify",
        modifyType: null,
        appointmentId: appt.appointment_id,
        services: appt.services
          ? appt.services.split(",").map(s => s.trim()).filter(Boolean)
          : [],
        location: appt.location,
        dateISO: appt.appointment_date.toISOString().split("T")[0],
        timeLabel: appt.appointment_time,
        totalPrice: appt.total_price,
      };

      const msg = `What would you like to modify?\n
1) Change services
2) Change branch
3) Change date
4) Change time
5) Change all
6) Cancel appointment
7) Back`;

      return res.json(
        makeReply(msg, "modifyMenu", { phone, tempBooking })
      );
    }

    /* STEP: modify menu */
    if (step === "modifyMenu") {
      const choice = text.trim();

      switch (choice) {
        case "1": // change services only
          tempBooking.modifyType = "services";
          return res.json(
            makeReply(
              "Select new services (tap to toggle) and press Done ✅.",
              "bookService",
              { phone, tempBooking }
            )
          );

        case "2": // change branch
          tempBooking.modifyType = "branch";
          return res.json(
            makeReply(
              "Choose a new branch:\n1) Miyapur\n2) Madhapur\n3) Jubilee Hills\n4) Banjara Hills",
              "bookBranch",
              { phone, tempBooking }
            )
          );

        case "3": // change date
          tempBooking.modifyType = "date";
          return res.json(
            makeReply(
              "Select new date (DD-MM-YYYY, within next 30 days).",
              "bookDate",
              { phone, tempBooking }
            )
          );

        case "4": // change time
          tempBooking.modifyType = "time";
          return res.json(
            makeReply(
              "Select new time between 10AM and 10PM (e.g., 4PM).",
              "bookTime",
              { phone, tempBooking }
            )
          );

        case "5": // change all
          tempBooking.modifyType = "all";
          return res.json(
            makeReply(
              "Let's update everything.\n\nFirst, pick services and press Done ✅.",
              "bookService",
              { phone, tempBooking }
            )
          );

        case "6": // cancel appointment
          await pool.query(
            "DELETE FROM appointments WHERE appointment_id=$1",
            [tempBooking.appointmentId]
          );
          return res.json(
            restartSession("❌ Appointment cancelled.", phone)
          );

        case "7": // back
          return res.json(
            makeReply("Returning to main menu.", "mainMenu", { phone })
          );

        default:
          return res.json(
            makeReply(
              "❌ Please choose a valid option (1–7).",
              "modifyMenu",
              { phone, tempBooking }
            )
          );
      }
    }

    /* STEP: bookService  (new + modify) */
    if (step === "bookService") {
      // For service selection we expect a special flag when user taps "Done"
      if (text !== "__done_services__") {
        return res.json(
          makeReply(
            "Please use the buttons to select services, then press Done ✅.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      if (!tempBooking.services || tempBooking.services.length === 0) {
        return res.json(
          makeReply(
            "❌ Please choose at least one valid service.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      const totalPrice = calculateTotalPrice(tempBooking.services);
      tempBooking.totalPrice = totalPrice;

      // MODIFY → services only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "services") {
        await pool.query(
          `UPDATE appointments
           SET services = $1, total_price = $2
           WHERE appointment_id = $3`,
          [
            tempBooking.services.join(", "),
            totalPrice,
            tempBooking.appointmentId,
          ]
        );

        return res.json(
          restartSession(
            `✅ Services updated.\nNew total: ₹${totalPrice}.`,
            phone
          )
        );
      }

      // MODIFY → change all (next: branch)
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "all") {
        return res.json(
          makeReply(
            "Choose a branch:\n1) Miyapur\n2) Madhapur\n3) Jubilee Hills\n4) Banjara Hills",
            "bookBranch",
            { phone, tempBooking }
          )
        );
      }

      // NEW booking
      tempBooking.mode = "new";
      return res.json(
        makeReply(
          "Choose a branch:\n1) Miyapur\n2) Madhapur\n3) Jubilee Hills\n4) Banjara Hills",
          "bookBranch",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: bookBranch */
    if (step === "bookBranch") {
      const n = Number(text);
      const branch = BRANCHES[n];

      if (!branch) {
        return res.json(
          makeReply(
            "❌ Please choose a valid branch (1–4).",
            "bookBranch",
            { phone, tempBooking }
          )
        );
      }

      // MODIFY → branch only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "branch") {
        await pool.query(
          `UPDATE appointments
           SET location=$1
           WHERE appointment_id=$2`,
          [branch, tempBooking.appointmentId]
        );

        return res.json(
          restartSession(
            `✅ Branch updated to ${branch}.`,
            phone
          )
        );
      }

      // MODIFY → change all or NEW: store & next
      tempBooking.location = branch;

      return res.json(
        makeReply(
          "📆 Select date (DD-MM-YYYY, within next 30 days).",
          "bookDate",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: bookDate */
    if (step === "bookDate") {
      const d = parseDateDDMMYYYY(text);

      if (!d) {
        return res.json(
          makeReply(
            "❌ Please enter a valid date in DD-MM-YYYY within the next 30 days.",
            "bookDate",
            { phone, tempBooking }
          )
        );
      }

      const iso = d.toISOString().split("T")[0];

      // MODIFY → date only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "date") {
        await pool.query(
          `UPDATE appointments
           SET appointment_date=$1
           WHERE appointment_id=$2`,
          [iso, tempBooking.appointmentId]
        );

        return res.json(
          restartSession(
            `✅ Date updated to ${iso}.`,
            phone
          )
        );
      }

      // MODIFY → change all or NEW
      tempBooking.dateISO = iso;

      return res.json(
        makeReply(
          "⏰ Select time between 10AM and 10PM (e.g., 4PM or 16).",
          "bookTime",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: bookTime */
    if (step === "bookTime") {
      const parsed = parseTime(text);

      if (!parsed) {
        return res.json(
          makeReply(
            "❌ Invalid time format. Try again (e.g., 4PM).",
            "bookTime",
            { phone, tempBooking }
          )
        );
      }

      const timeLabel = parsed.label;

      // MODIFY → time only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "time") {
        await pool.query(
          `UPDATE appointments
           SET appointment_time=$1
           WHERE appointment_id=$2`,
          [timeLabel, tempBooking.appointmentId]
        );

        return res.json(
          restartSession(
            `✅ Time updated to ${timeLabel}.`,
            phone
          )
        );
      }

      // MODIFY → change all (final UPDATE)
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "all") {
        const { services, totalPrice, location, dateISO } = tempBooking;

        await pool.query(
          `UPDATE appointments
           SET services=$1,
               location=$2,
               appointment_date=$3,
               appointment_time=$4,
               total_price=$5
           WHERE appointment_id=$6`,
          [
            services.join(", "),
            location,
            dateISO,
            timeLabel,
            totalPrice,
            tempBooking.appointmentId,
          ]
        );

        return res.json(
          restartSession(
            "🔄 Appointment fully updated.",
            phone
          )
        );
      }

      // NEW booking → INSERT
      const { services, totalPrice, location, dateISO } = tempBooking;

      await pool.query(
        `INSERT INTO appointments
         (customer_phone, services, location, appointment_date, appointment_time, total_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,'booked')`,
        [phone, services.join(", "), location, dateISO, timeLabel, totalPrice]
      );

      return res.json(
        restartSession(
          "🎉 Appointment confirmed!",
          phone
        )
      );
    }

    // fallback
    return res.json(
      makeReply(
        "Something went wrong... starting again.\nEnter phone number:",
        "phone"
      )
    );

  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json(
      makeReply(
        "Server error. Please try again.",
        "phone"
      )
    );
  }
});

/* ---------------------------------
   WHATSAPP WEBHOOK (stub for now)
   - GET /webhook : verification
   - POST /webhook: basic echo reply
   - Later we can hook into same flow
-----------------------------------*/

// Verification endpoint for Meta
app.get("/webhook", (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verifyToken) {
    console.log("✅ WhatsApp webhook verified");
    res.status(200).send(challenge);
  } else {
    console.log("❌ WhatsApp webhook verification failed");
    res.sendStatus(403);
  }
});

// Main WhatsApp webhook receiver
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const from = message.from; // WhatsApp phone
    const textBody = message.text?.body || "";

    console.log("📲 WhatsApp message:", from, "→", textBody);

    // For now, just send a simple reply.
    // Later we can hook this into the same booking logic.
    const reply =
      "Hi from Mithil's Salon WhatsApp bot 💇‍♂️\n\n" +
      "Right now this number is connected in test mode.\n" +
      "Website chatbot is fully working — WhatsApp flow coming soon!";

    await sendWhatsAppMessage(from, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error("whatsapp webhook error:", err.response?.data || err.message);
    res.sendStatus(500);
  }
});

// Helper: send WhatsApp message using Cloud API
async function sendWhatsAppMessage(to, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn("⚠️ WhatsApp env vars missing, not sending message");
    return;
  }

  const url = `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        text: { body: message },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("✅ WhatsApp message sent to", to);
  } catch (err) {
    console.error(
      "❌ Error sending WhatsApp message:",
      err.response?.data || err.message
    );
  }
}

/* ---------------------------------
   START SERVER
-----------------------------------*/

const PORT = process.env.PORT || 3000;

await connectDB();
app.listen(PORT, () => {
  console.log(`🚀 Server running → http://localhost:${PORT}`);
});
