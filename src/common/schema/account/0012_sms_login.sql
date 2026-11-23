ALTER TABLE users
    ADD COLUMN phone_e164 TEXT UNIQUE CHECK (phone_e164 ~ '^[+][1-9][0-9]{1,14}$');
