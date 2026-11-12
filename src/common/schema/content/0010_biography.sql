CREATE TABLE biography (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE RESTRICT,
    body TEXT NOT NULL CHECK (body ~ '[^[:space:]]'),
    updated_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON TABLE biography IS '每个用户当前的传记全文';
