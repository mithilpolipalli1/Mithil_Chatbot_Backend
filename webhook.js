import express from "express";
import axios from "axios";

const router = express.Router();

// VERIFY WEBHOOK (required by Meta)
router.get("/webhook", (req, res) => {
  const verify_token = process.env.WHATSAPP_VERIFY_TOKEN;
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === verify_token) {
    console.log("Webhook verified");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// RECEIVE MESSAGES
router.post("/webhook", async (req, res) => {
  const data = req.body;

  if (data.object) {
    const message = data.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

    if (message && message.type === "text") {
      const from = message.from;
      const text = message.text.body;

      // Reply logic here
      await sendMessage(from, "Hello! Reply received: " + text);
    }
    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

async function sendMessage(to, message) {
  const token = process.env.WHATSAPP_TOKEN;
  const apiUrl = `https://graph.facebook.com/v20.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;

  await axios.post(apiUrl, {
    messaging_product: "whatsapp",
    to,
    text: { body: message }
  }, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    }
  });
}

export default router;
