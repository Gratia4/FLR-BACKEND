CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE account_status AS ENUM ('PENDING', 'APPROVED', 'SUSPENDED', 'REJECTED');
CREATE TYPE user_role AS ENUM ('CLIENT', 'SUPER_ADMIN', 'SALES_MANAGER', 'CONTENT_MANAGER', 'LOGISTICS', 'FINANCE');
CREATE TYPE business_type AS ENUM ('PHARMACY', 'CLINIC_HOSPITAL', 'BEAUTY_RETAILER', 'SUPERMARKET', 'WHOLESALE_BUYER', 'OTHER');
CREATE TYPE stock_status AS ENUM ('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK', 'PRE_ORDER');
CREATE TYPE order_status AS ENUM ('DRAFT', 'SUBMITTED', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'INVOICED', 'CANCELLED');
CREATE TYPE registration_document_type AS ENUM ('BUSINESS_REGISTRATION', 'TIN_CERTIFICATE', 'PHARMACY_LICENCE', 'OPERATING_LICENCE', 'IDENTITY_DOCUMENT');

CREATE TABLE businesses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type business_type NOT NULL,
  registration_number text NOT NULL UNIQUE,
  tin text NOT NULL UNIQUE,
  pharmacy_licence_number text,
  operating_licence_number text NOT NULL,
  vat_registration_number text,
  street_address text NOT NULL,
  district text NOT NULL,
  country text NOT NULL DEFAULT 'Rwanda',
  whatsapp text,
  status account_status NOT NULL DEFAULT 'PENDING',
  status_reason text,
  credit_limit_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_limit_rwf >= 0),
  payment_terms_days integer NOT NULL DEFAULT 0 CHECK (payment_terms_days >= 0),
  assigned_account_manager_id uuid,
  approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid REFERENCES businesses(id) ON DELETE CASCADE,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  full_name text NOT NULL,
  job_title text NOT NULL,
  professional_licence_number text,
  phone text NOT NULL,
  role user_role NOT NULL DEFAULT 'CLIENT',
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_requires_business CHECK (role <> 'CLIENT' OR business_id IS NOT NULL)
);

ALTER TABLE businesses ADD CONSTRAINT businesses_account_manager_fkey
  FOREIGN KEY (assigned_account_manager_id) REFERENCES users(id) ON DELETE SET NULL;

CREATE TABLE registration_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type registration_document_type NOT NULL,
  original_name text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK (size_bytes > 0),
  verified_at timestamptz,
  uploaded_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE brands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  name text NOT NULL UNIQUE,
  origin text NOT NULL,
  category text NOT NULL,
  descriptor_en text,
  descriptor_fr text,
  logo_url text,
  hero_image_url text,
  priority_tier smallint NOT NULL DEFAULT 3 CHECK (priority_tier BETWEEN 1 AND 3),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id uuid NOT NULL REFERENCES brands(id) ON DELETE RESTRICT,
  sku text NOT NULL UNIQUE,
  brand_reference text,
  name text NOT NULL,
  description_en text,
  description_fr text,
  size text NOT NULL,
  image_urls text[] NOT NULL DEFAULT '{}',
  unit_price_rwf numeric(14,2) NOT NULL CHECK (unit_price_rwf >= 0),
  vat_included boolean NOT NULL DEFAULT false,
  minimum_order_quantity integer NOT NULL DEFAULT 1 CHECK (minimum_order_quantity > 0),
  case_size integer NOT NULL DEFAULT 1 CHECK (case_size > 0),
  stock_quantity integer NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  stock_status stock_status NOT NULL DEFAULT 'OUT_OF_STOCK',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE delivery_addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  label text NOT NULL,
  recipient_name text NOT NULL,
  phone text NOT NULL,
  street_address text NOT NULL,
  district text NOT NULL,
  country text NOT NULL DEFAULT 'Rwanda',
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reference text NOT NULL UNIQUE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  delivery_address_id uuid REFERENCES delivery_addresses(id) ON DELETE SET NULL,
  status order_status NOT NULL DEFAULT 'DRAFT',
  purchase_order_reference text,
  notes text,
  subtotal_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal_rwf >= 0),
  vat_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_rwf >= 0),
  total_rwf numeric(14,2) NOT NULL DEFAULT 0 CHECK (total_rwf >= 0),
  tracking_number text,
  submitted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  product_name text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price_rwf numeric(14,2) NOT NULL CHECK (unit_price_rwf >= 0),
  line_total_rwf numeric(14,2) NOT NULL CHECK (line_total_rwf >= 0),
  UNIQUE(order_id, product_id)
);

CREATE TABLE audit_logs (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX users_business_idx ON users(business_id);
CREATE INDEX businesses_status_idx ON businesses(status);
CREATE INDEX products_brand_active_idx ON products(brand_id, is_active);
CREATE INDEX products_stock_status_idx ON products(stock_status);
CREATE INDEX orders_business_created_idx ON orders(business_id, created_at DESC);
CREATE INDEX orders_status_idx ON orders(status);
CREATE INDEX audit_logs_actor_created_idx ON audit_logs(actor_user_id, created_at DESC);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER businesses_updated_at BEFORE UPDATE ON businesses FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER brands_updated_at BEFORE UPDATE ON brands FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER products_updated_at BEFORE UPDATE ON products FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER orders_updated_at BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION set_updated_at();
