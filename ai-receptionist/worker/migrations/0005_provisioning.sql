-- M5: automatic agent provisioning.

ALTER TABLE businesses ADD COLUMN template_version INTEGER;          -- agent_template.json version the agent was built from
ALTER TABLE businesses ADD COLUMN prompt_hash TEXT;                  -- hash of the prompt last pushed (skip no-op syncs)
ALTER TABLE businesses ADD COLUMN tool_ids_json TEXT;                -- ElevenLabs tool ids of this business's 6 webhook tools
ALTER TABLE businesses ADD COLUMN phone_number TEXT;                 -- E.164 number callers reach (Twilio)
ALTER TABLE businesses ADD COLUMN phone_number_id TEXT;              -- ElevenLabs phone number id
ALTER TABLE businesses ADD COLUMN provisioned_at TEXT;
ALTER TABLE businesses ADD COLUMN synced_at TEXT;
ALTER TABLE businesses ADD COLUMN provisioning_lock TEXT;            -- ISO time; stops two creates running at once

-- Small key/value store for one-off platform ids (e.g. the ElevenLabs workspace secret holding TOOL_SECRET).
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
