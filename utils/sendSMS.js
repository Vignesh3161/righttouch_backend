
import twilio from 'twilio';

export default async function sendSms(phoneNumber, otpCode) {
  const client = twilio(process.env.TWILIO_SID_SMS, process.env.TWILIO_TOKEN_SMS);
  try {
    const fullPhone = `+91${phoneNumber}`;
    await client.messages.create({
      from: process.env.SMS_SENDER,
      to: fullPhone,
      body: `Service App ${otpCode}`,
    });
  } catch (error) {
    console.error("Error sending SMS:", error);
    throw new Error("SMS could not be sent");
  }
}
