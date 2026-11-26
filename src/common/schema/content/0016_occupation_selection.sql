ALTER TABLE users
    ADD COLUMN occupation TEXT,
    ADD COLUMN occupation_topic_keys TEXT[] NOT NULL DEFAULT '{}';
