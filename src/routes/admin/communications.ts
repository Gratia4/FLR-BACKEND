import { Router } from "express";
import { z } from "zod";
import { query } from "../../db.js";
import { asyncHandler } from "../../lib/async-handler.js";
import { mails } from "../../lib/mailer.js";
import { requirePermission } from "../../middleware/authenticate.js";

const router = Router();
router.use(requirePermission("communications"));

router.get(
  "/",
  asyncHandler(async (request, response) => {
    const state = z.enum(["QUEUED", "SENT", "FAILED"]).optional().parse(request.query.state);
    const result = await query(
      `SELECT id,template,recipient,subject,state,error,sent_at,created_at
         FROM notifications
        WHERE ($1::notification_state IS NULL OR state=$1)
        ORDER BY created_at DESC LIMIT 300`,
      [state ?? null],
    );
    response.json({ data: result.rows });
  }),
);

router.post(
  "/broadcast",
  asyncHandler(async (request, response) => {
    const input = z.object({
      audience: z.enum(["ALL", "PHARMACY", "CLINIC_HOSPITAL", "BEAUTY_RETAILER", "SUPERMARKET", "WHOLESALE_BUYER", "OTHER"]),
      subject: z.string().min(3).max(150),
      message: z.string().min(5).max(3000),
    }).parse(request.body);

    const recipients = await query<{ email: string; full_name: string; business_name: string }>(
      `SELECT u.email,u.full_name,b.name AS business_name
         FROM users u JOIN businesses b ON b.id=u.business_id
        WHERE u.role='CLIENT' AND u.is_active AND b.status='APPROVED'
          AND ($1='ALL' OR b.type::text=$1)
        ORDER BY b.name`,
      [input.audience],
    );

    for (const recipient of recipients.rows) {
      await mails.broadcast(recipient.email, recipient.full_name, input.subject, input.message);
    }
    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'CLIENT_BROADCAST_SENT','notification',NULL,$2)`,
      [request.auth!.userId, JSON.stringify({ audience: input.audience, recipients: recipients.rowCount, subject: input.subject })],
    );
    response.status(201).json({ message: `Broadcast sent to ${recipients.rowCount} approved client${recipients.rowCount === 1 ? "" : "s"}.` });
  }),
);

export default router;
