import nodemailer from "nodemailer";

const transporter = nodemailer.createTransport({
  host: "smtp.mailersend.net",
  port: 587,
  secure: false,
  auth: {
    user: process.env.MAILERSEND_SMTP_USER,
    pass: process.env.MAILERSEND_SMTP_PASS,
  },
});

export const sendEmail = async (to, subject, text) => {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM,
      to,
      subject,
      text,
    });
    console.log("Email sent successfully");
  } catch (err) {
    console.error("MailerSend SMTP Error:", err);
    throw new Error("Email could not be sent");
  }
};

