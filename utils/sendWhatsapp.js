
import twilio from 'twilio';

export default async function sendWhatsapp(phoneNumber, otpCode) {
  const client = twilio(process.env.TWILIO_SID_WHATSAPP, process.env.TWILIO_TOKEN_WHATSAPP);
  try {
    const fullPhone = `whatsapp:+91${phoneNumber}`;
    await client.messages.create({
      from: process.env.WHATSAPP_SENDER,
      to: fullPhone,
      body: `Service App ${otpCode}`,
    });
  } catch (error) {
    console.error("Error sending SMS:", error);
    throw new Error("SMS could not be sent");
  }
}
