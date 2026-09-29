import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { config } from "../config.js";
import { query } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { authenticate, requirePermission } from "../middleware/authenticate.js";
import { localReadStream, objectExists, presignedUrl, type StorageProvider } from "../lib/storage.js";

const router = Router();

type DocumentRow = {
  id: string;
  business_id: string;
  type: string;
  original_name: string;
  storage_key: string;
  mime_type: string;
  size_bytes: number;
  provider: StorageProvider;
  verified_at: Date | null;
  business_name: string;
};

async function loadDocument(id: string) {
  const result = await query<DocumentRow>(
    `SELECT d.id,d.business_id,d.type,d.original_name,d.storage_key,d.mime_type,d.size_bytes,d.provider,
            d.verified_at, b.name AS business_name
       FROM registration_documents d JOIN businesses b ON b.id = d.business_id
      WHERE d.id = $1`,
    [id],
  );
  const document = result.rows[0];
  if (!document) throw new ApiError(404, "Document not found", "NOT_FOUND");
  return document;
}

/**
 * Compliance documents contain licence and identity data, so a URL is issued
 * per request, scoped to one document, and expires in minutes. Staff with the
 * registrations permission and the owning business may both request one.
 */
router.get(
  "/:id/link",
  authenticate,
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const document = await loadDocument(id);
    const auth = request.auth!;

    const isOwner = auth.businessId === document.business_id;
    const isReviewer = (["SUPER_ADMIN", "SALES_MANAGER"] as string[]).includes(auth.role);
    if (!isOwner && !isReviewer) throw new ApiError(403, "You cannot access this document", "FORBIDDEN");

    if (!(await objectExists(document.storage_key, document.provider))) {
      throw new ApiError(
        410,
        "This file is no longer present in storage. Ask the client to re-upload it.",
        "DOCUMENT_MISSING",
      );
    }

    const expiresAt = new Date(Date.now() + config.DOCUMENT_URL_TTL_SECONDS * 1000).toISOString();
    const direct = presignedUrl(document.storage_key, document.provider);
    const url =
      direct ??
      `${request.protocol}://${request.get("host")}/api/v1/documents/${id}/raw?token=${jwt.sign(
        { purpose: "document", documentId: id, sub: auth.userId },
        config.JWT_SECRET,
        { expiresIn: config.DOCUMENT_URL_TTL_SECONDS },
      )}`;

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'DOCUMENT_ACCESSED','registration_document',$2,$3)`,
      [auth.userId, id, JSON.stringify({ businessId: document.business_id, type: document.type })],
    );

    response.json({
      data: {
        url,
        expiresAt,
        filename: document.original_name,
        mimeType: document.mime_type,
        sizeBytes: document.size_bytes,
        inline: true,
      },
    });
  }),
);

/** Streams a locally stored document. Authorised by the one-shot link token only. */
router.get(
  "/:id/raw",
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const token = z.string().min(10).parse(request.query.token);

    let claims: { purpose?: string; documentId?: string };
    try {
      claims = jwt.verify(token, config.JWT_SECRET) as typeof claims;
    } catch {
      throw new ApiError(401, "This download link has expired", "LINK_EXPIRED");
    }
    if (claims.purpose !== "document" || claims.documentId !== id) {
      throw new ApiError(403, "This link is not valid for that document", "FORBIDDEN");
    }

    const document = await loadDocument(id);
    if (document.provider !== "LOCAL") throw new ApiError(400, "This document is not stored locally", "WRONG_DRIVER");

    response.setHeader("Content-Type", document.mime_type);
    response.setHeader("Content-Length", String(document.size_bytes));
    response.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(document.original_name)}"`);
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");

    localReadStream(document.storage_key)
      .on("error", () => {
        if (!response.headersSent) response.status(410).json({ error: { code: "DOCUMENT_MISSING", message: "File not found in storage" } });
        else response.end();
      })
      .pipe(response);
  }),
);

/** Compliance sign-off on an individual document. */
router.patch(
  "/:id/review",
  authenticate,
  requirePermission("registrations"),
  asyncHandler(async (request, response) => {
    const id = z.uuid().parse(request.params.id);
    const input = z
      .object({ verified: z.boolean(), rejectionReason: z.string().max(500).optional() })
      .parse(request.body);
    if (!input.verified && !input.rejectionReason) {
      throw new ApiError(422, "Give a reason when rejecting a document", "REASON_REQUIRED");
    }

    const result = await query(
      `UPDATE registration_documents
          SET verified_at = CASE WHEN $2 THEN now() ELSE NULL END,
              verified_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END,
              rejection_reason = $4
        WHERE id = $1
        RETURNING id, type, verified_at, rejection_reason`,
      [id, input.verified, request.auth!.userId, input.rejectionReason ?? null],
    );
    if (!result.rowCount) throw new ApiError(404, "Document not found", "NOT_FOUND");

    await query(
      `INSERT INTO audit_logs(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'DOCUMENT_REVIEWED','registration_document',$2,$3)`,
      [request.auth!.userId, id, JSON.stringify(input)],
    );
    response.json({ data: result.rows[0] });
  }),
);

export default router;
