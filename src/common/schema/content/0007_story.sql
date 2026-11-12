CREATE TABLE story (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    summary TEXT,
    chapter_id BIGINT REFERENCES chapter(id) ON DELETE RESTRICT,
    source_session_id TEXT,
    photo_layout JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(photo_layout) = 'array'),
    profile_processed BOOLEAN NOT NULL DEFAULT FALSE,
    life_event_processed BOOLEAN NOT NULL DEFAULT FALSE,
    life_event_id BIGINT REFERENCES life_events(id) ON DELETE RESTRICT,
    create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_story_life_event_id ON story (life_event_id);

COMMENT ON TABLE story IS '访谈成文后保存的故事标题与正文';
COMMENT ON COLUMN story.id IS '自增故事编号';
COMMENT ON COLUMN story.user_id IS '故事所属用户，关联 users.id';
COMMENT ON COLUMN story.title IS '成文标题';
COMMENT ON COLUMN story.body IS '成文正文';
COMMENT ON COLUMN story.summary IS '本次访谈摘要，供后续访谈承接使用；尚未生成时为空';
COMMENT ON COLUMN story.chapter_id IS '故事所属章节，成文时继承访谈话题；旧记录可能为空';
COMMENT ON COLUMN story.source_session_id IS '故事来源访谈会话 ID，用于鉴权读取配图';
COMMENT ON COLUMN story.photo_layout IS
    '配图列表：media_id 为图片编号；after_paragraph 为正文段落序号（从 1 起），空值表示文末';
COMMENT ON COLUMN story.profile_processed IS '本篇故事的画像提取已处理，包括无新增内容或仅待核实建议';
COMMENT ON COLUMN story.life_event_processed IS '本篇故事的经历归纳已处理，包括决定跳过归纳';
COMMENT ON COLUMN story.life_event_id IS '故事所属的人生经历，尚未归纳或跳过时为空';
COMMENT ON COLUMN story.create_time IS '故事首次入库时间';
