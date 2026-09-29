-- ============================================================
-- 003: Full product schema
-- Batch/expiry traceability, invoicing, payments, returns,
-- tier pricing, server-side carts, auth tokens, stock ledger.
-- ============================================================

CREATE TYPE invoice_status   AS ENUM ('DRAFT','ISSUED','PARTIALLY_PAID','PAID','OVERDUE','CANCELLED','CREDITED');
CREATE TYPE payment_method   AS ENUM ('MTN_MOMO','AIRTEL_MONEY','BANK_TRANSFER','CASH','CHEQUE','CREDIT_NOTE');
CREATE TYPE payment_status   AS ENUM ('PENDING','CONFIRMED','FAILED','REVERSED');
CREATE TYPE return_status    AS ENUM ('REQUESTED','APPROVED','RECEIVED','CREDITED','REJECTED');
CREATE TYPE return_reason    AS ENUM ('DAMAGED','EXPIRED','WRONG_ITEM','SHORT_DATED','RECALL','OTHER');
CREATE TYPE movement_reason  AS ENUM ('RECEIPT','ORDER','CANCELLATION','RETURN','ADJUSTMENT','EXPIRY_WRITE_OFF','RECALL');
CREATE TYPE storage_provider AS ENUM ('LOCAL','S3');
CREATE TYPE notification_channel AS ENUM ('EMAIL');
CREATE TYPE notification_state   AS ENUM ('QUEUED','SENT','FAILED');

-- ---------- products: compliance + commercial fields ----------
ALTER TABLE products
  ADD COLUMN vat_rate numeric(5,4) NOT NULL DEFAULT 0.18 CHECK (vat_rate >= 0 AND vat_rate <= 1),
  ADD COLUMN category text,
  ADD COLUMN requires_prescription boolean NOT NULL DEFAULT false,
  ADD COLUMN cold_chain boolean NOT NULL DEFAULT false,
  ADD COLUMN controlled_substance boolean NOT NULL DEFAULT false,
  ADD COLUMN reorder_level integer NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  ADD COLUMN shelf_life_days integer CHECK (shelf_life_days IS NULL OR shelf_life_days > 0);

-- Legacy rows only carried a `vat_included` boolean. Treat those as
-- standard-rated and everything else as exempt until finance reviews it.
UPDATE products SET vat_rate = CASE WHEN vat_included THEN 0.18 ELSE 0 END;

-- ---------- batch / lot traceability (Rwanda FDA) ----------
CREATE TABLE product_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_number text NOT NULL,
  expiry_date date NOT NULL,
  manufactured_on date,
  quantity_received integer NOT NULL CHECK (quantity_received > 0),
  quantity_remaining integer NOT NULL CHECK (quantity_remaining >= 0),
  supplier text,
  received_at timestamptz NOT NULL DEFAULT now(),
  recalled_at timestamptz,
  recall_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, batch_number),
  CHECK (quantity_remaining <= quantity_received)
);

-- ---------- immutable stock ledger ----------
CREATE TABLE stock_movements (
  id bigserial PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  batch_id uuid REFERENCES product_batches(id) ON DELETE SET NULL,
  reason movement_reason NOT NULL,
  quantity_delta integer NOT NULL CHECK (quantity_delta <> 0),
  balance_after integer NOT NULL CHECK (balance_after >= 0),
  reference_type text,
  reference_id text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- which batches satisfied which order line (recall traceability)
CREATE TABLE order_item_batches (
  id bigserial PRIMARY KEY,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  batch_id uuid NOT NULL REFERENCES product_batches(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  UNIQUE (order_item_id, batch_id)
);

-- ---------- client-specific pricing ----------
CREATE TABLE price_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  discount_percent numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_percent >= 0 AND discount_percent < 100),
  minimum_monthly_rwf numeric(14,2) NOT NULL DEFAULT 0,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO price_tiers (code,name,discount_percent,minimum_monthly_rwf,is_default) VALUES
  ('STANDARD','Standard wholesale',0,0,true),
  ('SILVER','Silver partner',3.00,2000000,false),
  ('GOLD','Gold partner',6.00,6000000,false),
  ('KEY_ACCOUNT','Key account',9.00,15000000,false);

ALTER TABLE businesses
  ADD COLUMN price_tier_id uuid REFERENCES price_tiers(id) ON DELETE SET NULL,
  ADD COLUMN credit_hold boolean NOT NULL DEFAULT false;

UPDATE businesses SET price_tier_id = (SELECT id FROM price_tiers WHERE code = 'STANDARD');

-- volume breaks: quantity >= min_quantity earns this unit price
CREATE TABLE product_price_breaks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  min_quantity integer NOT NULL CHECK (min_quantity > 1),
  unit_price_rwf numeric(14,2) NOT NULL CHECK (unit_price_rwf >= 0),
  UNIQUE (product_id, min_quantity)
);

-- ---------- orders: VAT, delivery, lifecycle ----------
ALTER TABLE orders
  ADD COLUMN discount_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (discount_rwf >= 0),
  ADD COLUMN delivery_fee_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (delivery_fee_rwf >= 0),
  ADD COLUMN expected_delivery_date date,
  ADD COLUMN cancelled_reason text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN delivered_at timestamptz;

ALTER TABLE order_items
  ADD COLUMN vat_rate numeric(5,4) NOT NULL DEFAULT 0,
  ADD COLUMN vat_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_rwf >= 0),
  ADD COLUMN list_price_rwf numeric(14,2);

UPDATE order_items SET list_price_rwf = unit_price_rwf WHERE list_price_rwf IS NULL;

-- ---------- invoicing (RRA / EBM ready) ----------
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  status invoice_status NOT NULL DEFAULT 'ISSUED',
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  subtotal_rwf numeric(14,2) NOT NULL CHECK (subtotal_rwf >= 0),
  vat_rwf numeric(14,2) NOT NULL CHECK (vat_rwf >= 0),
  total_rwf numeric(14,2) NOT NULL CHECK (total_rwf >= 0),
  amount_paid_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (amount_paid_rwf >= 0),
  ebm_receipt_number text,
  ebm_internal_data text,
  ebm_signature text,
  ebm_submitted_at timestamptz,
  issued_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id)
);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'PENDING',
  amount_rwf numeric(14,2) NOT NULL CHECK (amount_rwf > 0),
  external_reference text,
  payer_note text,
  received_at timestamptz,
  recorded_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- returns & credit notes ----------
CREATE TABLE returns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  status return_status NOT NULL DEFAULT 'REQUESTED',
  reason return_reason NOT NULL,
  note text,
  credit_note_reference text,
  credit_amount_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_amount_rwf >= 0),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id uuid NOT NULL REFERENCES order_items(id) ON DELETE RESTRICT,
  quantity integer NOT NULL CHECK (quantity > 0),
  restock boolean NOT NULL DEFAULT false,
  UNIQUE (return_id, order_item_id)
);

-- ---------- persistent cart ----------
CREATE TABLE cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity integer NOT NULL CHECK (quantity > 0),
  added_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, product_id)
);

-- ---------- auth: refresh + password reset ----------
CREATE TABLE refresh_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  ip_address text,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users
  ADD COLUMN failed_login_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until timestamptz,
  ADD COLUMN must_change_password boolean NOT NULL DEFAULT false,
  ADD COLUMN preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en','fr','rw'));

-- ---------- documents: object storage ----------
ALTER TABLE registration_documents
  ADD COLUMN provider storage_provider NOT NULL DEFAULT 'LOCAL',
  ADD COLUMN checksum text,
  ADD COLUMN verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN rejection_reason text;

-- ---------- outbound notifications ----------
CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  channel notification_channel NOT NULL DEFAULT 'EMAIL',
  template text NOT NULL,
  recipient text NOT NULL,
  subject text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  state notification_state NOT NULL DEFAULT 'QUEUED',
  error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- derived stock status ----------
CREATE OR REPLACE FUNCTION sync_stock_status() RETURNS trigger AS $$
BEGIN
  IF NEW.stock_status <> 'PRE_ORDER' THEN
    NEW.stock_status := CASE
      WHEN NEW.stock_quantity = 0 THEN 'OUT_OF_STOCK'::stock_status
      WHEN NEW.stock_quantity <= GREATEST(NEW.reorder_level, 1) THEN 'LOW_STOCK'::stock_status
      ELSE 'IN_STOCK'::stock_status
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_stock_status BEFORE INSERT OR UPDATE OF stock_quantity, reorder_level
  ON products FOR EACH ROW EXECUTE FUNCTION sync_stock_status();

UPDATE products SET stock_quantity = stock_quantity;   -- backfill via the trigger

CREATE TRIGGER product_batches_updated_at BEFORE UPDATE ON product_batches FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER invoices_updated_at   BEFORE UPDATE ON invoices   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER payments_updated_at   BEFORE UPDATE ON payments   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER returns_updated_at    BEFORE UPDATE ON returns    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER cart_items_updated_at BEFORE UPDATE ON cart_items FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------- indexes ----------
CREATE INDEX batches_product_expiry_idx ON product_batches(product_id, expiry_date);
CREATE INDEX batches_expiry_idx         ON product_batches(expiry_date) WHERE quantity_remaining > 0;
CREATE INDEX movements_product_idx      ON stock_movements(product_id, created_at DESC);
CREATE INDEX invoices_business_idx      ON invoices(business_id, issued_at DESC);
CREATE INDEX invoices_status_due_idx    ON invoices(status, due_at);
CREATE INDEX payments_business_idx      ON payments(business_id, created_at DESC);
CREATE INDEX returns_business_idx       ON returns(business_id, created_at DESC);
CREATE INDEX cart_business_idx          ON cart_items(business_id);
CREATE INDEX refresh_user_idx           ON refresh_tokens(user_id) WHERE revoked_at IS NULL;
CREATE INDEX reset_user_idx             ON password_reset_tokens(user_id) WHERE used_at IS NULL;
CREATE INDEX documents_business_idx     ON registration_documents(business_id);
CREATE INDEX notifications_state_idx    ON notifications(state, created_at);
