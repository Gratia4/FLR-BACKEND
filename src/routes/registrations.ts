import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { transaction } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { createReference } from "../lib/reference.js";
import { mails } from "../lib/mailer.js";
import { buildDocumentKey, deleteObject, putObject, type StoredObject } from "../lib/storage.js";

const router = Router();

const ACCEPTED_MIME = ["application/pdf", "image/jpeg", "image/png"];

/**
 * Files are buffered in memory rather than written to disk so nothing is
 * persisted until the whole application validates, and so the storage driver
 * (local or S3/R2) decides where bytes finally land.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 5 },
  fileFilter: (_request, file, callback) =>
    ACCEPTED_MIME.includes(file.mimetype)
      ? callback(null, true)
      : callback(new ApiError(415, `${file.originalname} must be a PDF, JPG or PNG`, "UNSUPPORTED_FILE_TYPE")),
});

const DOCUMENT_FIELDS = {
  businessRegistration: "BUSINESS_REGISTRATION",
  tinCertificate: "TIN_CERTIFICATE",
  pharmacyLicence: "PHARMACY_LICENCE",
  operatingLicence: "OPERATING_LICENCE",
  identityDocument: "IDENTITY_DOCUMENT",
} as const;

const REQUIRED_FIELDS = ["businessRegistration", "tinCertificate", "operatingLicence", "identityDocument"] as const;

const FIELD_LABELS: Record<string, string> = {
  businessRegistration: "Business registration certificate",
  tinCertificate: "TIN certificate",
  pharmacyLicence: "Pharmacy licence",
  operatingLicence: "Operating licence",
  identityDocument: "National ID or passport",
};

const schema = z
  .object({
    businessName: z.string().min(2).max(200),
    businessType: z.enum(["PHARMACY", "CLINIC_HOSPITAL", "BEAUTY_RETAILER", "SUPERMARKET", "WHOLESALE_BUYER", "OTHER"]),
    registrationNumber: z.string().min(3).max(100),
    tin: z.string().regex(/^\d{9}$/, "Rwanda TIN must contain exactly 9 digits"),
    pharmacyLicenceNumber: z.string().max(100).optional(),
    operatingLicenceNumber: z.string().min(2).max(100),
    vatRegistrationNumber: z.string().max(100).optional(),
    streetAddress: z.string().min(3).max(250),
    district: z.string().min(2).max(100),
    country: z.string().min(2).max(100).default("Rwanda"),
    fullName: z.string().min(2).max(150),
    jobTitle: z.string().min(2).max(100),
    professionalLicenceNumber: z.string().max(100).optional(),
    email: z.email(),
    phone: z.string().min(8).max(30),
    whatsapp: z.string().max(30).optional(),
    preferredLanguage: z.enum(["en", "fr", "rw"]).default("en"),
    password: z
      .string()
      .min(8)
      .max(128)
      .regex(/[A-Z]/, "Include an uppercase letter")
      .regex(/[0-9]/, "Include a number")
      .regex(/[^A-Za-z0-9]/, "Include a symbol"),
    acceptTerms: z.literal("true"),
    acceptPrivacy: z.literal("true"),
    acceptWholesaleAgreement: z.literal("true"),
  })
  .superRefine((value, context) => {
    if (value.businessType === "PHARMACY" && !value.pharmacyLicenceNumber) {
      context.addIssue({ code: "custom", path: ["pharmacyLicenceNumber"], message: "Required for pharmacies" });
    }
  });

router.post(
  "/",
  upload.fields(Object.keys(DOCUMENT_FIELDS).map((name) => ({ name, maxCount: 1 }))),
  asyncHandler(async (request, response) => {
    const input = schema.parse(request.body);
    const files = request.files as Record<string, Express.Multer.File[]> | undefined;

    for (const field of REQUIRED_FIELDS) {
      if (!files?.[field]?.[0]) throw new ApiError(422, `${FIELD_LABELS[field]} is required`, "MISSING_DOCUMENT", { field });
    }
    if (input.businessType === "PHARMACY" && !files?.pharmacyLicence?.[0]) {
      throw new ApiError(422, "Pharmacies must attach a valid pharmacy licence", "MISSING_DOCUMENT", { field: "pharmacyLicence" });
    }

    const reference = createReference("REG");
    const passwordHash = await bcrypt.hash(input.password, 12);

    // Upload first: if storage is unreachable we fail before creating an account
    // that would otherwise exist with no supporting documents.
    const uploaded: Array<StoredObject & { field: string; originalName: string; mimeType: string }> = [];
    try {
      for (const [field, values] of Object.entries(files ?? {})) {
        const documentType = DOCUMENT_FIELDS[field as keyof typeof DOCUMENT_FIELDS];
        if (!documentType) continue;
        for (const file of values) {
          const key = buildDocumentKey(reference, documentType, file.mimetype);
          const stored = await putObject(key, file.buffer, file.mimetype);
          uploaded.push({ ...stored, field, originalName: file.originalname, mimeType: file.mimetype });
        }
      }

      const businessId = await transaction(async (client) => {
        const business = await client.query<{ id: string }>(
          `INSERT INTO businesses
             (name,type,registration_number,tin,pharmacy_licence_number,operating_licence_number,
              vat_registration_number,street_address,district,country,whatsapp,price_tier_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT id FROM price_tiers WHERE is_default LIMIT 1))
           RETURNING id`,
          [
            input.businessName,
            input.businessType,
            input.registrationNumber,
            input.tin,
            input.pharmacyLicenceNumber ?? null,
            input.operatingLicenceNumber,
            input.vatRegistrationNumber ?? null,
            input.streetAddress,
            input.district,
            input.country,
            input.whatsapp ?? null,
          ],
        );
        const id = business.rows[0]!.id;

        await client.query(
          `INSERT INTO users (business_id,email,password_hash,full_name,job_title,professional_licence_number,phone,preferred_language)
           VALUES($1,lower($2),$3,$4,$5,$6,$7,$8)`,
          [
            id,
            input.email,
            passwordHash,
            input.fullName,
            input.jobTitle,
            input.professionalLicenceNumber ?? null,
            input.phone,
            input.preferredLanguage,
          ],
        );

        // The primary trading address doubles as the default delivery address.
        await client.query(
          `INSERT INTO delivery_addresses(business_id,label,recipient_name,phone,street_address,district,country,is_default)
           VALUES($1,'Main premises',$2,$3,$4,$5,$6,true)`,
          [id, input.fullName, input.phone, input.streetAddress, input.district, input.country],
        );

        for (const document of uploaded) {
          await client.query(
            `INSERT INTO registration_documents
               (business_id,type,original_name,storage_key,mime_type,size_bytes,provider,checksum)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
            [
              id,
              DOCUMENT_FIELDS[document.field as keyof typeof DOCUMENT_FIELDS],
              document.originalName,
              document.key,
              document.mimeType,
              document.sizeBytes,
              document.provider,
              document.checksum,
            ],
          );
        }

        await client.query(
          `INSERT INTO audit_logs(action,entity_type,entity_id,metadata)
           VALUES('REGISTRATION_SUBMITTED','business',$1,$2)`,
          [id, JSON.stringify({ reference, documents: uploaded.length })],
        );
        return id;
      });

      await mails.registrationReceived(input.email, input.fullName, reference);
      if (config.OPS_NOTIFICATION_EMAIL) {
        await mails.registrationAlert(config.OPS_NOTIFICATION_EMAIL, input.businessName, input.businessType, reference);
      }

      response.status(201).json({
        reference,
        businessId,
        status: "PENDING",
        message: "Registration received. Our team will review it within 24–48 business hours.",
      });
    } catch (error) {
      // Nothing was committed, so the uploaded objects are orphans — remove them.
      await Promise.all(uploaded.map((document) => deleteObject(document.key, document.provider).catch(() => undefined)));
      throw error;
    }
  }),
);

export default router;
