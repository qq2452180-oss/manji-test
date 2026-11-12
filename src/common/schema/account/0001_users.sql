CREATE TABLE users (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    token TEXT UNIQUE,
    is_guest BOOLEAN NOT NULL DEFAULT FALSE,
    create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN users.password IS 'Argon2id 密码哈希，不保存明文密码';
COMMENT ON COLUMN users.token IS '当前随机登录凭证的 SHA-256 摘要；本版不自动过期';
COMMENT ON COLUMN users.is_guest IS
    '体验身份；注册时原地改为正式账号，保留用户编号及其访谈、图片和故事';
