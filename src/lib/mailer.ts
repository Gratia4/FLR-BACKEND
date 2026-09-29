import { config } from "../config.js";
import { query } from "../db.js";

export type MailTemplate =
  | "registration-received"
  | "registration-alert"
  | "account-approved"
  | "account-more-info"
  | "account-rejected"
  | "account-suspended"
  | "order-confirmation"
  | "order-status"
  | "invoice-issued"
  | "payment-received"
  | "password-reset"
  | "staff-invite"
  | "stock-digest"
  | "broadcast";

type Mail = { to: string; subject: string; heading: string; body: string[]; cta?: { label: string; href: string }; footnote?: string };

/* ---------------- brand shell ---------------- */

const FOREST = "#10271b";
const GREEN = "#2e7d32";
const GOLD = "#f9a825";
const BLUE = "#1565c0";

function render({ heading, body, cta, footnote }: Mail) {
  const paragraphs = body
    .map((line) => `<p style="margin:0 0 14px;font-size:14px;line-height:1.65;color:#3d4a40;">${line}</p>`)
    .join("");
  const button = cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 8px;">
         <tr><td style="border-radius:6px;background:${GREEN};">
           <a href="${cta.href}" style="display:inline-block;padding:13px 24px;font:700 13px 'Helvetica Neue',Arial,sans-serif;color:#fff;text-decoration:none;">${cta.label}</a>
         </td></tr>
       </table>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f3f6f3;font-family:'Helvetica Neue',Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f6f3;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 12px 32px #14291a14;">
        <tr><td style="height:5px;padding:0;background:${GREEN};"></td></tr>
        <tr><td style="padding:26px 34px 0;">
          <span style="font:800 20px 'Helvetica Neue',Arial,sans-serif;color:${FOREST};">FLR Ltd.</span>
          <span style="display:block;margin-top:3px;font-size:9px;letter-spacing:1.6px;text-transform:uppercase;color:${GOLD};font-weight:700;">Pharmaceutical Wholesale · Dépôt Pharmaceutique</span>
        </td></tr>
        <tr><td style="padding:24px 34px 32px;">
          <h1 style="margin:0 0 16px;font:800 22px 'Helvetica Neue',Arial,sans-serif;color:${FOREST};line-height:1.25;">${heading}</h1>
          ${paragraphs}${button}
          ${footnote ? `<p style="margin:22px 0 0;padding-top:18px;border-top:1px solid #e3e9e4;font-size:11px;line-height:1.6;color:#78847a;">${footnote}</p>` : ""}
        </td></tr>
        <tr><td style="padding:18px 34px;background:${FOREST};">
          <p style="margin:0;font-size:10px;line-height:1.7;color:#9fb6a5;">FLR Ltd. · Kigali, Rwanda · This is an automated message from the FLR partner portal.</p>
        </td></tr>
        <tr><td style="height:5px;padding:0;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            <td style="height:5px;background:${GREEN};"></td><td style="height:5px;background:${GOLD};"></td><td style="height:5px;background:${BLUE};"></td>
          </tr></table>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function plainText({ heading, body, cta, footnote }: Mail) {
  return [heading, "", ...body.map(stripTags), cta ? `\n${cta.label}: ${cta.href}` : "", footnote ? `\n${stripTags(footnote)}` : ""]
    .filter(Boolean)
    .join("\n");
}

const stripTags = (value: string) => value.replace(/<[^>]+>/g, "");
const html = (value: string | number) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

/* ---------------- delivery ---------------- */

/**
 * Every message is journalled in `notifications` before delivery is attempted,
 * so a failed send is visible in the admin console rather than lost.
 * Delivery failures never bubble up — a client must not lose their order
 * because the mail provider is down.
 */
export async function sendMail(template: MailTemplate, mail: Mail, payload: Record<string, unknown> = {}) {
  const inserted = await query<{ id: string }>(
    `INSERT INTO notifications(template,recipient,subject,payload) VALUES($1,$2,$3,$4) RETURNING id`,
    [template, mail.to, mail.subject, JSON.stringify(payload)],
  );
  const id = inserted.rows[0]!.id;

  try {
    if (config.MAIL_DRIVER === "resend") {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${config.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({
          from: config.MAIL_FROM,
          to: [mail.to],
          subject: mail.subject,
          html: render(mail),
          text: plainText(mail),
        }),
      });
      if (!response.ok) throw new Error(`Resend responded ${response.status}: ${(await response.text()).slice(0, 200)}`);
    } else {
      console.info(`[mail:${template}] → ${mail.to} :: ${mail.subject}`);
      if (mail.cta) console.info(`[mail:${template}] cta ${mail.cta.href}`);
    }
    await query(`UPDATE notifications SET state='SENT', sent_at=now() WHERE id=$1`, [id]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown mail error";
    console.error(`[mail:${template}] delivery failed`, message);
    await query(`UPDATE notifications SET state='FAILED', error=$2 WHERE id=$1`, [id, message]);
  }
}

/* ---------------- templates ---------------- */

const money = (value: number | string) =>
  `RWF ${new Intl.NumberFormat("en-RW", { maximumFractionDigits: 0 }).format(Number(value))}`;

const portal = (path: string) => `${config.publicAppUrl}${path}`;

export const mails = {
  registrationReceived: (to: string, name: string, reference: string) =>
    sendMail("registration-received", {
      to,
      subject: `FLR partner registration received — ${reference}`,
      heading: "We have your application",
      body: [
        `Thank you, ${html(name)}. Your request for an FLR wholesale account has been received.`,
        `Your reference is <strong>${html(reference)}</strong>. Our compliance team verifies your trading licence and TIN, normally within 24–48 business hours.`,
        "You will receive an email as soon as a decision is made. No action is needed from you in the meantime.",
      ],
      footnote: "Keep this reference for any correspondence with the FLR team.",
    }, { reference }),

  registrationAlert: (to: string, businessName: string, businessType: string, reference: string) =>
    sendMail("registration-alert", {
      to,
      subject: `New partner application — ${businessName}`,
      heading: "A new application needs review",
      body: [
        `<strong>${html(businessName)}</strong> (${html(businessType.replaceAll("_", " ").toLowerCase())}) submitted a wholesale account request.`,
        `Reference ${html(reference)}. Licence documents are attached to the application record.`,
      ],
      cta: { label: "Review application", href: portal("/admin") },
    }, { reference, businessName }),

  accountApproved: (to: string, name: string, businessName: string) =>
    sendMail("account-approved", {
      to,
      subject: "Your FLR wholesale account is active",
      heading: "You're approved",
      body: [
        `${html(name)}, the account for <strong>${html(businessName)}</strong> has been verified and approved.`,
        "You can now sign in to view confidential wholesale pricing, place orders and track deliveries.",
      ],
      cta: { label: "Sign in to the portal", href: portal("/login") },
      footnote: "Wholesale pricing is confidential and must not be shared outside your business.",
    }, { businessName }),

  accountMoreInfo: (to: string, name: string, businessName: string, reason: string) =>
    sendMail("account-more-info", {
      to,
      subject: "More information is needed for your FLR application",
      heading: "Please update your application",
      body: [
        `${html(name)}, our team reviewed the application for <strong>${html(businessName)}</strong>.`,
        `<strong>Information required:</strong> ${html(reason)}`,
        "Please reply to the FLR team with the requested information so the compliance review can continue.",
      ],
    }, { businessName, reason }),

  accountRejected: (to: string, name: string, businessName: string, reason: string) =>
    sendMail("account-rejected", {
      to,
      subject: "Update on your FLR partner application",
      heading: "We could not approve this application",
      body: [
        `${html(name)}, we have completed our review of <strong>${html(businessName)}</strong> and are unable to approve the account at this time.`,
        `<strong>Reason:</strong> ${html(reason)}`,
        "If you believe this decision was made in error, or you can supply further documentation, please reply to our sales team.",
      ],
    }, { businessName, reason }),

  accountSuspended: (to: string, name: string, businessName: string, reason: string) =>
    sendMail("account-suspended", {
      to,
      subject: "Your FLR account has been restricted",
      heading: "Account temporarily restricted",
      body: [
        `${html(name)}, ordering on <strong>${html(businessName)}</strong> has been suspended.`,
        `<strong>Reason:</strong> ${html(reason)}`,
        "Please contact your FLR account manager to resolve this and restore access.",
      ],
    }, { businessName, reason }),

  orderConfirmation: (to: string, name: string, reference: string, total: string | number, itemCount: number) =>
    sendMail("order-confirmation", {
      to,
      subject: `Order ${reference} confirmed`,
      heading: "Order received",
      body: [
        `Thank you, ${html(name)}. We have your order <strong>${html(reference)}</strong>.`,
        `${itemCount} line item${itemCount === 1 ? "" : "s"} · Total <strong>${money(total)}</strong> (VAT included where applicable).`,
        "Our logistics team will confirm the dispatch date shortly. You can follow progress in the portal at any time.",
      ],
      cta: { label: "Track this order", href: portal(`/portal/orders?ref=${encodeURIComponent(reference)}`) },
    }, { reference, total }),

  orderStatus: (to: string, reference: string, status: string, trackingNumber?: string | null) =>
    sendMail("order-status", {
      to,
      subject: `Order ${reference} is now ${status.toLowerCase()}`,
      heading: `Order ${status.toLowerCase()}`,
      body: [
        `Your order <strong>${html(reference)}</strong> has moved to <strong>${html(status.toLowerCase())}</strong>.`,
        trackingNumber ? `Tracking reference: <strong>${html(trackingNumber)}</strong>.` : "",
      ].filter(Boolean),
      cta: { label: "View order", href: portal(`/portal/orders?ref=${encodeURIComponent(reference)}`) },
    }, { reference, status }),

  invoiceIssued: (to: string, reference: string, total: string | number, dueDate: string) =>
    sendMail("invoice-issued", {
      to,
      subject: `Invoice ${reference}`,
      heading: "Your invoice is ready",
      body: [
        `Invoice <strong>${html(reference)}</strong> has been issued for <strong>${money(total)}</strong>.`,
        `Payment is due by <strong>${html(dueDate)}</strong>.`,
        "We accept MTN MoMo, Airtel Money and bank transfer. Quote the invoice reference with your payment.",
      ],
      cta: { label: "View invoice", href: portal("/portal/invoices") },
    }, { reference, total, dueDate }),

  paymentReceived: (to: string, reference: string, amount: string | number, invoiceReference: string | null) =>
    sendMail("payment-received", {
      to,
      subject: `Payment received — ${money(amount)}`,
      heading: "Payment confirmed",
      body: [
        `We have recorded your payment of <strong>${money(amount)}</strong> (receipt ${html(reference)}).`,
        invoiceReference ? `This has been applied to invoice <strong>${html(invoiceReference)}</strong>.` : "This has been credited to your account balance.",
      ],
      cta: { label: "View statement", href: portal("/portal/invoices") },
    }, { reference, amount }),

  broadcast: (to: string, name: string, subject: string, message: string) =>
    sendMail("broadcast", {
      to,
      subject,
      heading: subject,
      body: [`Hello ${html(name)},`, html(message).replaceAll("\n", "<br>")],
      cta: { label: "Open the FLR portal", href: portal("/login") },
      footnote: "This message was sent to approved FLR wholesale partners.",
    }, { subject }),

  passwordReset: (to: string, name: string, token: string, minutes: number) =>
    sendMail("password-reset", {
      to,
      subject: "Reset your FLR portal password",
      heading: "Password reset requested",
      body: [
        `${html(name)}, we received a request to reset the password on your FLR portal account.`,
        `This link expires in ${minutes} minutes and can be used once.`,
      ],
      cta: { label: "Choose a new password", href: portal(`/reset-password?token=${encodeURIComponent(token)}`) },
      footnote: "If you did not request this, you can safely ignore this email — your password will not change.",
    }),

  staffInvite: (to: string, name: string, role: string, temporaryPassword: string) =>
    sendMail("staff-invite", {
      to,
      subject: "Your FLR management console account",
      heading: "Welcome to the FLR console",
      body: [
        `${html(name)}, an account has been created for you with the <strong>${html(role.replaceAll("_", " ").toLowerCase())}</strong> role.`,
        `Your temporary password is <strong>${html(temporaryPassword)}</strong>. You will be asked to change it the first time you sign in.`,
      ],
      cta: { label: "Sign in", href: portal("/login") },
      footnote: "Never share this password. FLR staff will never ask you for it.",
    }, { role }),

  stockDigest: (to: string, lowStock: number, expiring: number, expired: number) =>
    sendMail("stock-digest", {
      to,
      subject: `Inventory alert — ${lowStock} low, ${expiring} expiring`,
      heading: "Daily inventory alert",
      body: [
        `<strong>${lowStock}</strong> product${lowStock === 1 ? "" : "s"} at or below reorder level.`,
        `<strong>${expiring}</strong> batch${expiring === 1 ? "" : "es"} expiring within ${config.EXPIRY_ALERT_DAYS} days.`,
        `<strong>${expired}</strong> batch${expired === 1 ? "" : "es"} already expired and still marked as sellable stock.`,
      ],
      cta: { label: "Open inventory", href: portal("/admin/inventory") },
    }, { lowStock, expiring, expired }),
};
