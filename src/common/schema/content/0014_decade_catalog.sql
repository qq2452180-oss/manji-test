ALTER TABLE users ADD COLUMN birth_decade SMALLINT CHECK (birth_decade IN (50, 60, 70));
ALTER TABLE chapter ADD COLUMN birth_decade SMALLINT CHECK (birth_decade IN (50, 60, 70)),
    ADD COLUMN volume_title TEXT,
    DROP CONSTRAINT chapter_title_key;
CREATE UNIQUE INDEX idx_chapter_legacy_title ON chapter(title) WHERE birth_decade IS NULL;
CREATE UNIQUE INDEX idx_chapter_decade_title ON chapter(birth_decade, title) WHERE birth_decade IS NOT NULL;
ALTER TABLE topic ADD COLUMN section_title TEXT;
