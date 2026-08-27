// simplified: one schema string is consumed by both SQLite adapters so table drift is impossible.
export const MAILUO_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  company TEXT,
  title TEXT,
  phone TEXT,
  wechat_id TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS screenshots (
  id INTEGER PRIMARY KEY,
  image_path TEXT NOT NULL,
  user_note TEXT,
  raw_extraction TEXT,
  uploaded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_cards (
  id INTEGER PRIMARY KEY,
  screenshot_id INTEGER NOT NULL REFERENCES screenshots(id),
  type TEXT NOT NULL CHECK(type IN ('create_contact','update_contact','create_meeting','record_interaction')),
  payload TEXT NOT NULL,
  confidence TEXT NOT NULL CHECK(confidence IN ('high','medium','low')),
  source_quote TEXT NOT NULL,
  disambiguation TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','rejected')),
  resolved_contact_id INTEGER REFERENCES contacts(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  screenshot_id INTEGER REFERENCES screenshots(id),
  kind TEXT NOT NULL CHECK(kind IN ('fact','preference','status_change','interaction')),
  content TEXT NOT NULL,
  source_quote TEXT,
  observed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  time_iso TEXT,
  time_text TEXT NOT NULL,
  location TEXT,
  participants TEXT NOT NULL DEFAULT '[]',
  agenda TEXT,
  source_screenshot_id INTEGER REFERENCES screenshots(id),
  status TEXT NOT NULL DEFAULT 'upcoming',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  kind TEXT NOT NULL CHECK(kind IN ('relationship_read','suggested_action','conversation_hook')),
  content TEXT NOT NULL,
  based_on TEXT NOT NULL DEFAULT '[]',
  generated_at TEXT NOT NULL
);
`;
