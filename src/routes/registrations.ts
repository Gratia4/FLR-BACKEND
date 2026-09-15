import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Router } from "express";
import bcrypt from "bcryptjs";
import multer from "multer";
import { z } from "zod";
import { config } from "../config.js";
import { transaction } from "../db.js";
import { asyncHandler } from "../lib/async-handler.js";
import { ApiError } from "../lib/errors.js";
import { createReference } from "../lib/reference.js";

await mkdir(config.UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: config.UPLOAD_DIR,
  filename: (_request, file, callback) => callback(null, `${randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
const upload = multer({ storage, limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 5 }, fileFilter: (_request, file, callback) => callback(null, ["application/pdf", "image/jpeg", "image/png"].includes(file.mimetype)) });
const router = Router();

const schema = z.object({
  businessName: z.string().min(2).max(200),
  businessType: z.enum(["PHARMACY", "CLINIC_HOSPITAL", "BEAUTY_RETAILER", "SUPERMARKET", "WHOLESALE_BUYER", "OTHER"]),
  registrationNumber: z.string().min(3).max(100),
  tin: z.string().regex(/^\d{9}$/, "Rwanda TIN must contain exactly 9 digits"),
  pharmacyLicenceNumber: z.string().max(100).optional(),
  operatingLicenceNumber: z.string().min(2).max(100),
  vatRegistrationNumber: z.string().max(100).optional(),
  streetAddress: z.string().min(3).max(250), district: z.string().min(2).max(100), country: z.string().min(2).max(100).default("Rwanda"),
  fullName: z.string().min(2).max(150), jobTitle: z.string().min(2).max(100), professionalLicenceNumber: z.string().max(100).optional(),
  email: z.email(), phone: z.string().min(8).max(30), whatsapp: z.string().max(30).optional(),
  password: z.string().min(8).max(128).regex(/[A-Z]/).regex(/[0-9]/).regex(/[^A-Za-z0-9]/),
  acceptTerms: z.literal("true"), acceptPrivacy: z.literal("true"), acceptWholesaleAgreement: z.literal("true"),
}).superRefine((value, context) => {
  if (value.businessType === "PHARMACY" && !value.pharmacyLicenceNumber) context.addIssue({ code: "custom", path: ["pharmacyLicenceNumber"], message: "Required for pharmacies" });
});

router.post("/", upload.fields([
  { name: "businessRegistration", maxCount: 1 }, { name: "tinCertificate", maxCount: 1 }, { name: "pharmacyLicence", maxCount: 1 },
  { name: "operatingLicence", maxCount: 1 }, { name: "identityDocument", maxCount: 1 },
]), asyncHandler(async (request, response) => {
  const input = schema.parse(request.body);
  const files = request.files as Record<string, Express.Multer.File[]> | undefined;
  for (const required of ["businessRegistration", "tinCertificate", "operatingLicence", "identityDocument"]) {
    if (!files?.[required]?.[0]) throw new ApiError(422, `${required} document is required`, "MISSING_DOCUMENT");
  }
  if (input.businessType === "PHARMACY" && !files?.pharmacyLicence?.[0]) throw new ApiError(422, "Pharmacy licence document is required", "MISSING_DOCUMENT");
  const passwordHash = await bcrypt.hash(input.password, 12);
  const reference = createReference("REG");
  const businessId = await transaction(async (client) => {
    const business = await client.query<{ id: string }>(`INSERT INTO businesses
      (name,type,registration_number,tin,pharmacy_licence_number,operating_licence_number,vat_registration_number,street_address,district,country,whatsapp)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [input.businessName,input.businessType,input.registrationNumber,input.tin,input.pharmacyLicenceNumber ?? null,input.operatingLicenceNumber,input.vatRegistrationNumber ?? null,input.streetAddress,input.district,input.country,input.whatsapp ?? null]);
    const id = business.rows[0]!.id;
    await client.query(`INSERT INTO users (business_id,email,password_hash,full_name,job_title,professional_licence_number,phone)
      VALUES($1,lower($2),$3,$4,$5,$6,$7)`, [id,input.email,passwordHash,input.fullName,input.jobTitle,input.professionalLicenceNumber ?? null,input.phone]);
    const types: Record<string,string> = { businessRegistration:"BUSINESS_REGISTRATION", tinCertificate:"TIN_CERTIFICATE", pharmacyLicence:"PHARMACY_LICENCE", operatingLicence:"OPERATING_LICENCE", identityDocument:"IDENTITY_DOCUMENT" };
    for (const [field, values] of Object.entries(files ?? {})) for (const file of values) await client.query(`INSERT INTO registration_documents
      (business_id,type,original_name,storage_key,mime_type,size_bytes) VALUES($1,$2,$3,$4,$5,$6)`, [id,types[field],file.originalname,file.filename,file.mimetype,file.size]);
    await client.query("INSERT INTO audit_logs(action,entity_type,entity_id,metadata) VALUES('REGISTRATION_SUBMITTED','business',$1,$2)", [id,JSON.stringify({ reference })]);
    return id;
  });
  response.status(201).json({ reference, businessId, status: "PENDING", message: "Registration received. Our team will review it within 24–48 business hours." });
}));

export default router;
