import nodemailer from "nodemailer";

export const sendEmail = async (to, subject, text) => {
  try {
    // Create transporter
    const transporter = nodemailer.createTransport({
      host:"smtp.gmail.com", // e.g. "smtp.gmail.com"
      port: "587", // e.g. 587
      secure: false, // true for 465, false for other ports
      auth: {
        user:"gokila1305@gmail.com", // Your email
        pass: "dklocgiabjsvozwm"  // Your email password or app password
      }
    });

    // Send mail
    const info = await transporter.sendMail({
      from: `"Service App" <${"gokila1305@gmail.com"}>`,
      to,
      subject,
      text
    });

    console.log(`Email sent: ${info.messageId}`);
  } catch (error) {
    console.error("Error sending email:", error);
    throw new Error("Email could not be sent");
  }
};
