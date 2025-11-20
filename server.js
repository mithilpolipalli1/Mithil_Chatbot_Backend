// server.js
import express from "express";
import cors from "cors";
import { pool, connectDB } from "./db.js";

const app = express();
app.use(cors());
app.use(express.json());

/* ---------------------------------
   CONSTANTS & HELPERS
-----------------------------------*/

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good Morning";
  if (hour < 18) return "Good Afternoon";
  return "Good Evening";
}

// Services: names as keys for easy lookup
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

// Utility to build a response object
function respond(reply, nextStep, extra = {}) {
  return { reply, nextStep, ...extra };
}

// Restart flow back to main menu
function restart(reply, phone) {
  return {
    reply:
      `${reply}\n\n🔁 Session restarted.\n\n👇 Choose what to do next:`,
    nextStep: "mainMenu",
    phone,
  };
}

// calculate total price for a list of service names
function calculateTotalPrice(services = []) {
  return services.reduce(
    (sum, s) => sum + (SERVICE_PRICES[s] || 0),
    0
  );
}

// parse main menu choice string
function parseMenu(text) {
  const t = text.trim().toLowerCase();
  if (["1", "book", "book appointment"].includes(t)) return "book";
  if (["2", "view", "view appointments"].includes(t)) return "view";
  if (
    ["3", "modify", "reschedule", "reschedule / cancel", "reschedule/cancel"]
      .includes(t)
  )
    return "modify";
  return null;
}

// parse DD-MM-YYYY within next 30 days
function parseDate(text) {
  const parts = text.split(/[-/]/);
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

// parse "4PM" / "10AM" / "16" etc
function parseTime(text) {
  if (!text) return null;
  let t = text.trim().toUpperCase().replace(/\s+/g, "");

  // e.g. 4PM, 10AM, 12PM
  let match = t.match(/^(\d{1,2})(AM|PM)$/);
  if (match) {
    let h = Number(match[1]);
    const ampm = match[2];
    let hour24 = h;

    if (ampm === "PM" && h !== 12) hour24 += 12;
    if (ampm === "AM" && h === 12) hour24 = 0;

    if (hour24 < 10 || hour24 > 22) return null;

    const label = `${((hour24 + 11) % 12) + 1}${ampm}`;
    return { hour24, label };
  }

  // e.g. 16
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

/* ---------------------------------
   MAIN CHAT ROUTE
-----------------------------------*/

app.post("/chat", async (req, res) => {
  try {
    let { text, step, phone, tempBooking } = req.body;
    text = (text || "").trim();
    step = step || "phone";

    // tempBooking holds session state for booking / modify
    tempBooking = tempBooking || {};
    tempBooking.services = tempBooking.services || [];

    /* STEP: PHONE LOGIN */
    if (step === "phone") {
      const digits = text.replace(/\D/g, "");
      if (digits.length !== 10) {
        return res.json(
          respond("Please enter a valid 10-digit phone number.", "phone")
        );
      }

      phone = digits;
      const result = await pool.query(
        "SELECT * FROM salon_users WHERE phone=$1",
        [phone]
      );

      if (result.rows.length > 0) {
        const user = result.rows[0];
        const greet = getGreeting();

        return res.json(
          respond(
            `${greet} ${user.name.toLowerCase()}! 👋\n👇 Choose an option:`,
            "mainMenu",
            { phone }
          )
        );
      }

      // New user
      return res.json(
        respond("You're new here 🌟 What's your good name?", "newUserName", {
          phone,
        })
      );
    }

    /* STEP: NEW USER NAME */
    if (step === "newUserName") {
      const name = text || "Guest";

      await pool.query(
        "INSERT INTO salon_users (phone, name) VALUES ($1,$2)",
        [phone, name]
      );

      const greet = getGreeting();

      return res.json(
        respond(
          `${greet} ${name.toLowerCase()}! 👋\n🎉 You get **50% OFF on your first service!**\n\n👇 Choose an option:`,
          "mainMenu",
          { phone }
        )
      );
    }

    /* STEP: MAIN MENU */
    if (step === "mainMenu") {
      const choice = parseMenu(text);

      if (!choice) {
        return res.json(
          respond("👇 Please choose an option below.", "mainMenu", { phone })
        );
      }

      // New booking
      if (choice === "book") {
        // new mode
        tempBooking = {
          mode: "new",
          modifyType: null,
          services: [],
        };

        return res.json(
          respond(
            "Which services do you want?\n\nTap to select, then press Done.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      // View appointments
      if (choice === "view") {
        const result = await pool.query(
          `SELECT services, location, appointment_date, appointment_time, total_price
           FROM appointments
           WHERE customer_phone=$1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length) {
          return res.json(
            respond("📭 You have no appointments yet.", "mainMenu", { phone })
          );
        }

        const lines = result.rows.map((r, i) => {
          const d = r.appointment_date.toISOString().split("T")[0];
          const price = r.total_price ? ` - ₹${r.total_price}` : "";
          return `${i + 1}) ${r.services} at ${r.location} on ${d} ${
            r.appointment_time
          }${price}`;
        });

        return res.json(
          respond(
            `📋 Your appointments:\n\n${lines.join("\n")}`,
            "mainMenu",
            { phone }
          )
        );
      }

      // Reschedule / Cancel / Modify
      if (choice === "modify") {
        const result = await pool.query(
          `SELECT appointment_id, services, location, appointment_date, appointment_time, total_price
           FROM appointments
           WHERE customer_phone=$1
           ORDER BY appointment_date, appointment_time`,
          [phone]
        );

        if (!result.rows.length) {
          return res.json(
            respond("📭 You have no appointments to modify.", "mainMenu", {
              phone,
            })
          );
        }

        const lines = result.rows.map((r, i) => {
          const d = r.appointment_date.toISOString().split("T")[0];
          const price = r.total_price ? ` - ₹${r.total_price}` : "";
          return `${i + 1}) ${r.services} at ${r.location} on ${d} ${
            r.appointment_time
          }${price}`;
        });

        return res.json(
          respond(
            `🛠 Select an appointment to modify:\n\n${lines.join("\n")}`,
            "modifyPick",
            { phone }
          )
        );
      }
    }

    /* STEP: PICK APPOINTMENT TO MODIFY */
    if (step === "modifyPick") {
      const result = await pool.query(
        `SELECT appointment_id, services, location, appointment_date, appointment_time, total_price
         FROM appointments
         WHERE customer_phone=$1
         ORDER BY appointment_date, appointment_time`,
        [phone]
      );

      const idx = Number(text) - 1;
      if (Number.isNaN(idx) || idx < 0 || idx >= result.rows.length) {
        return res.json(
          respond("❌ Invalid number. Try again.", "modifyPick", { phone })
        );
      }

      const appt = result.rows[idx];

      tempBooking = {
        mode: "modify",
        modifyType: null,
        appointmentId: appt.appointment_id,
        services: appt.services ? appt.services.split(", ").filter(Boolean) : [],
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
        respond(msg, "modifyMenu", { phone, tempBooking })
      );
    }

    /* STEP: MODIFY MENU */
    if (step === "modifyMenu") {
      const choice = text.trim();

      switch (choice) {
        case "1": // services
          tempBooking.modifyType = "services";
          // existing services will show as pre-selected in UI
          return res.json(
            respond(
              "Select new services (tap to toggle) and press Done.",
              "bookService",
              { phone, tempBooking }
            )
          );

        case "2": // branch
          tempBooking.modifyType = "branch";
          return res.json(
            respond("Choose new branch:", "bookBranch", {
              phone,
              tempBooking,
            })
          );

        case "3": // date
          tempBooking.modifyType = "date";
          return res.json(
            respond("Select new date (DD-MM-YYYY):", "bookDate", {
              phone,
              tempBooking,
            })
          );

        case "4": // time
          tempBooking.modifyType = "time";
          return res.json(
            respond("Select new time (e.g., 4PM):", "bookTime", {
              phone,
              tempBooking,
            })
          );

        case "5": // change all
          tempBooking.modifyType = "all";
          return res.json(
            respond(
              "Let's update everything.\n\nFirst, select services and press Done.",
              "bookService",
              { phone, tempBooking }
            )
          );

        case "6": // cancel appointment
          await pool.query(
            "DELETE FROM appointments WHERE appointment_id=$1",
            [tempBooking.appointmentId]
          );
          return res.json(restart("❌ Appointment cancelled.", phone));

        case "7": // back
          return res.json(
            respond("Returning to main menu.", "mainMenu", { phone })
          );

        default:
          return res.json(
            respond(
              "❌ Please choose 1–7.",
              "modifyMenu",
              { phone, tempBooking }
            )
          );
      }
    }

    /* STEP: BOOK SERVICE (USED BY NEW + MODIFY) */
    if (step === "bookService") {
      // We only accept button-based flow
      if (text !== "__done_services__") {
        return res.json(
          respond(
            "Please select services using the buttons, then press Done.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      // Done pressed
      if (!tempBooking.services || tempBooking.services.length === 0) {
        return res.json(
          respond(
            "❌ Please select at least one service.",
            "bookService",
            { phone, tempBooking }
          )
        );
      }

      const totalPrice = calculateTotalPrice(tempBooking.services);
      tempBooking.totalPrice = totalPrice;

      // MODIFY: only services
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "services") {
        // update only services + price
        await pool.query(
          `UPDATE appointments
           SET services=$1, total_price=$2
           WHERE appointment_id=$3`,
          [
            tempBooking.services.join(", "),
            totalPrice,
            tempBooking.appointmentId,
          ]
        );

        return res.json(
          restart(
            `✅ Services updated.\nNew total: ₹${totalPrice}.`,
            phone
          )
        );
      }

      // MODIFY: change all – next step: branch (but no DB yet)
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "all") {
        return res.json(
          respond(
            "Choose new branch:",
            "bookBranch",
            { phone, tempBooking }
          )
        );
      }

      // NEW booking
      tempBooking.mode = "new";
      return res.json(
        respond(
          "Choose a branch:",
          "bookBranch",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: BOOK BRANCH (USED BY NEW + MODIFY) */
    if (step === "bookBranch") {
      const n = Number(text);
      const branch = BRANCHES[n];

      if (!branch) {
        return res.json(
          respond(
            "❌ Please select a valid branch (1–4).",
            "bookBranch",
            { phone, tempBooking }
          )
        );
      }

      // MODIFY: branch only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "branch") {
        await pool.query(
          `UPDATE appointments
           SET location=$1
           WHERE appointment_id=$2`,
          [branch, tempBooking.appointmentId]
        );

        return res.json(
          restart(
            `✅ Branch changed to ${branch}.`,
            phone
          )
        );
      }

      // MODIFY: change all or NEW – just store and move on
      tempBooking.location = branch;

      return res.json(
        respond(
          "📆 Select date (DD-MM-YYYY):",
          "bookDate",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: BOOK DATE */
    if (step === "bookDate") {
      const d = parseDate(text);

      if (!d) {
        return res.json(
          respond(
            "❌ Invalid date. Please use DD-MM-YYYY within next 30 days.",
            "bookDate",
            { phone, tempBooking }
          )
        );
      }

      const iso = d.toISOString().split("T")[0];

      // MODIFY: date only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "date") {
        await pool.query(
          `UPDATE appointments
           SET appointment_date=$1
           WHERE appointment_id=$2`,
          [iso, tempBooking.appointmentId]
        );

        return res.json(
          restart(`✅ Date updated to ${iso}.`, phone)
        );
      }

      // MODIFY: change all or NEW – store and proceed
      tempBooking.dateISO = iso;

      return res.json(
        respond(
          "⏰ Select time (e.g., 4PM):",
          "bookTime",
          { phone, tempBooking }
        )
      );
    }

    /* STEP: BOOK TIME */
    if (step === "bookTime") {
      const t = parseTime(text);

      if (!t) {
        return res.json(
          respond(
            "❌ Invalid time. Please choose between 10AM and 10PM.",
            "bookTime",
            { phone, tempBooking }
          )
        );
      }

      const timeLabel = t.label;

      // MODIFY: time only
      if (tempBooking.mode === "modify" && tempBooking.modifyType === "time") {
        await pool.query(
          `UPDATE appointments
           SET appointment_time=$1
           WHERE appointment_id=$2`,
          [timeLabel, tempBooking.appointmentId]
        );

        return res.json(
          restart(`✅ Time updated to ${timeLabel}.`, phone)
        );
      }

      // MODIFY: change all – final UPDATE with all new data
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
          restart("🔄 Appointment fully updated.", phone)
        );
      }

      // NEW booking – insert
      const { services, totalPrice, location, dateISO } = tempBooking;

      await pool.query(
        `INSERT INTO appointments
         (customer_phone, services, location, appointment_date, appointment_time, total_price, status)
         VALUES ($1,$2,$3,$4,$5,$6,'booked')`,
        [phone, services.join(", "), location, dateISO, timeLabel, totalPrice]
      );

      return res.json(
        restart("🎉 Appointment confirmed!", phone)
      );
    }

    // Fallback
    return res.json(
      respond("Something went wrong. Starting again.\n\nEnter phone number:", "phone")
    );
  } catch (err) {
    console.error("chat error:", err);
    return res.status(500).json(
      respond("Server error. Please try again.", "phone")
    );
  }
});

/* ---------------------------------
   START SERVER
-----------------------------------*/

const PORT = 3000;
await connectDB();
app.listen(PORT, () => {
  console.log(`🚀 Server running → http://localhost:${PORT}`);
});
