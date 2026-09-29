-- Internal CRM notes for approved wholesale accounts.
CREATE TABLE client_account_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  note text NOT NULL CHECK (char_length(trim(note)) BETWEEN 2 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX client_account_notes_business_created_idx
  ON client_account_notes (business_id, created_at DESC);
