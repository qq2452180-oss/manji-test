ALTER TABLE users ADD COLUMN token_expires_at TIMESTAMPTZ;

-- 旧记录没有签发时间，给已有正式用户从本次迁移起算的 30 天过渡期。
UPDATE users SET token_expires_at = statement_timestamp() + INTERVAL '720 hours'
WHERE token IS NOT NULL AND NOT is_guest;

-- 所有签发入口（包括滚动发布期间的旧版本）在同一条写入中设置期限。
CREATE FUNCTION set_member_token_expiry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.token IS NULL OR NEW.is_guest THEN
        NEW.token_expires_at := NULL;
    ELSIF TG_OP = 'INSERT' OR NEW.token IS DISTINCT FROM OLD.token OR OLD.is_guest THEN
        NEW.token_expires_at := statement_timestamp() + INTERVAL '720 hours';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER users_set_token_expiry BEFORE INSERT OR UPDATE OF token, is_guest ON users
FOR EACH ROW EXECUTE FUNCTION set_member_token_expiry();

ALTER TABLE users ADD CONSTRAINT users_member_token_expiry_check
CHECK ((token_expires_at IS NOT NULL) = (token IS NOT NULL AND NOT is_guest));

COMMENT ON COLUMN users.token IS '当前随机登录凭证的 SHA-256 摘要，重新登录时替换，退出时清除';
COMMENT ON COLUMN users.token_expires_at IS '正式账号登录凭证固定 30 天有效，访问不续期';
