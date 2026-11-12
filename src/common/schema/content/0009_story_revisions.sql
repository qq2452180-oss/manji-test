-- 增量升级：保留已有故事、来源会话与所有问答。
ALTER TABLE story ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE story ADD COLUMN updated_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE story SET updated_time = create_time;

CREATE TABLE story_revisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    story_id BIGINT NOT NULL REFERENCES story(id) ON DELETE RESTRICT,
    source_session_id TEXT NOT NULL UNIQUE,
    base_version BIGINT NOT NULL CHECK (base_version > 0),
    applied_version BIGINT,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK (attempt > 0),
    base_story JSONB NOT NULL CHECK (jsonb_typeof(base_story) = 'object'),
    original_story JSONB NOT NULL CHECK (jsonb_typeof(original_story) = 'object'),
    title TEXT,
    body TEXT,
    photo_layout JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(photo_layout) = 'array'),
    summary TEXT,
    profile_processed BOOLEAN NOT NULL DEFAULT FALSE,
    life_event_processed BOOLEAN NOT NULL DEFAULT FALSE,
    life_event_id BIGINT REFERENCES life_events(id) ON DELETE RESTRICT,
    status TEXT NOT NULL DEFAULT 'interviewing'
        CHECK (status IN ('interviewing', 'pending', 'applied', 'conflict', 'completed')),
    create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK ((applied_version IS NULL) = (status IN ('interviewing', 'pending', 'conflict'))),
    CHECK (applied_version IS NULL OR (title IS NOT NULL AND body IS NOT NULL))
);

CREATE UNIQUE INDEX idx_story_one_active_supplement ON story_revisions (story_id)
    WHERE status <> 'completed';
CREATE INDEX idx_story_revisions_owner_story ON story_revisions (user_id, story_id, id);
COMMENT ON TABLE story_revisions IS '补充访谈的原文快照、融合候选及按会话独立保存的访后处理进度';
COMMENT ON COLUMN story_revisions.original_story IS '补充开始时的原故事快照，重新整理不会覆盖，用于恢复原始会话结果';
COMMENT ON COLUMN story_revisions.base_story IS '本次整理尝试所基于的故事快照';
COMMENT ON COLUMN story_revisions.attempt IS '重新整理时递增，拒绝旧尝试的迟到结果';
COMMENT ON COLUMN story.version IS '正文和配图每次修改递增，用于并发编辑与补充的版本校验';
