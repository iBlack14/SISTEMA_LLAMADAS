import nodemailer from "nodemailer";

export function createMailer(smtpSettings) {
  let cached = null;

  async function transporter() {
    const settings = await smtpSettings.get();
    if (!settings || !settings.host || !settings.fromAddress) {
      throw Object.assign(new Error("El administrador aún no configuró el correo SMTP."), { status: 503 });
    }
    const fingerprint = `${settings.host}|${settings.port}|${settings.secure}|${settings.username}|${settings.password}|${settings.fromAddress}`;
    if (cached && cached.fingerprint === fingerprint) return cached.transport;
    const transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.username
        ? { user: settings.username, pass: settings.password }
        : undefined,
      pool: true,
      maxConnections: 2,
      maxMessages: 50,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    });
    cached = { fingerprint, transport };
    return transport;
  }

  async function verify() {
    const transport = await transporter();
    await transport.verify();
    const settings = await smtpSettings.get();
    return { ok: true, from: settings.fromAddress };
  }

  async function send({ to, subject, body, attachments = [] }) {
    const transport = await transporter();
    const settings = await smtpSettings.get();
    const info = await transport.sendMail({
      from: settings.fromName ? `"${settings.fromName}" <${settings.fromAddress}>` : settings.fromAddress,
      to,
      subject,
      text: body,
      attachments: attachments.map(file => ({
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype
      }))
    });
    return { messageId: info.messageId || "" };
  }

  return { verify, send, transporter };
}
