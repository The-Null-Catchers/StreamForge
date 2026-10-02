import nodemailer from "nodemailer";
import { config } from "../../../packages/config/src/index.js";

const transport = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  auth: config.SMTP_USER
    ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
    : undefined,
});

export async function sendMail(message: {
  to: string;
  subject: string;
  text: string;
}) {
  await transport.sendMail({
    from: config.MAIL_FROM,
    ...message,
  });
}

export async function sendWorkspaceInvite(input: {
  to: string;
  workspaceName: string;
  role: string;
  token: string;
}) {
  const link = `${config.PUBLIC_URL}/?invite=${encodeURIComponent(input.token)}`;
  await sendMail({
    to: input.to,
    subject: "You have been invited to StreamForge",
    text: [
      `You were invited to join "${input.workspaceName}" as ${input.role}.`,
      "",
      `Open ${link}`,
      "",
      "This invitation expires in 7 days. If you were not expecting it, you can ignore this email.",
    ].join("\n"),
  });
}
