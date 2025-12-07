import express from "express";
import axios from "axios";

const router = express.Router();

// RAW MSG91 WEBHOOK RECEIVER
router.post("/", async (req, res) => {
  try {
    const incoming = req.body;

    // Extract message & sender number
    const msg = incoming?.data?.message?.text;
    const phone = incoming?.data?.message?.from;

    if (!msg || !phone) {
      console.log("Webhook hit but no message.");
      return res.sendStatus(200);
    }

    console.log("📩 Incoming:", msg, "from", phone);

    // Forward to your chatbot
    const botResponse = await axios.post(
      `${process.env.BACKEND_PUBLIC_URL}/api/chat`,
      {
        text: msg,
        phone: phone,
        step: "phone", // auto detect
      }
    );

    const reply = botResponse.data?.reply || "Thank you!";

    // Send reply using MSG91 API
    await axios.post(
      "https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message",
      {
        integrated_number: process.env.MSG91_INTEGRATED_NUMBER,
        payload: {
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: reply },
        },
      },
      {
        headers: {
          authkey: process.env.MSG91_AUTHKEY,
          "Content-Type": "application/json",
        },
      }
    );

    return res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    return res.sendStatus(500);
  }
});

export default router;
