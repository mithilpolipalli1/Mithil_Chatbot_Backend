import express from "express";
import axios from "axios";

const router = express.Router();

// MSG91 always sends POST → no verification required
router.post("/webhook", async (req, res) => {
  try {
    const data = req.body;

    const from = data.sender;
    const text = data.message;

    // Send to your AI logic inside server.js
    const botResponse = await axios.post("http://localhost:8011/api/chat", {
      text,
      phone: from
    });

    const reply = botResponse.data.reply;

    // Send reply back to MSG91 WhatsApp
    await sendMsg91Message(from, reply);

    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook Error:", err);
    res.sendStatus(500);
  }
});

async function sendMsg91Message(to, message) {
  const apiKey = process.env.MSG91_API_KEY;

  await axios.post(
    "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound",
    {
      to,
      type: "text",
      message
    },
    {
      headers: {
        authkey: apiKey,
        "Content-Type": "application/json"
      }
    }
  );
}

export default router;
