ALTER TABLE api_tokens ADD COLUMN max_requests_per_minute INTEGER NOT NULL DEFAULT 60;
ALTER TABLE api_tokens ADD COLUMN max_writes_per_hour INTEGER NOT NULL DEFAULT 30;
ALTER TABLE api_tokens ADD COLUMN last_ip_prefix TEXT;
ALTER TABLE api_tokens ADD COLUMN last_ip_changed_at TEXT;

CREATE TABLE token_rate_windows (
  token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  window_kind TEXT NOT NULL CHECK (window_kind IN ('request_minute', 'write_hour')),
  window_start TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (token_id, window_kind, window_start)
);

CREATE INDEX idx_token_rate_windows_cleanup
  ON token_rate_windows(window_start);

CREATE TABLE token_usage_daily (
  token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  usage_date TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  reads INTEGER NOT NULL DEFAULT 0,
  searches INTEGER NOT NULL DEFAULT 0,
  proposals INTEGER NOT NULL DEFAULT 0,
  writes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0,
  throttles INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  PRIMARY KEY (token_id, usage_date)
);

CREATE INDEX idx_token_usage_daily_date
  ON token_usage_daily(usage_date);

CREATE TABLE token_mutation_receipts (
  token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  failed_at TEXT,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (token_id, operation_id)
);

CREATE INDEX idx_token_mutation_receipts_cleanup
  ON token_mutation_receipts(expires_at);
