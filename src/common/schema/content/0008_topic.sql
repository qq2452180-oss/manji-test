CREATE TABLE topic (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    chapter_id BIGINT NOT NULL
        REFERENCES chapter(id) ON DELETE RESTRICT,
    title TEXT NOT NULL,
    description TEXT NOT NULL
        CHECK (btrim(description) <> ''),
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_topic_chapter_sort
    ON topic (chapter_id, sort_order, id);

COMMENT ON TABLE topic IS '章节下的访谈话题；具体提问由访谈节点结合画像、经历索引及当前回答生成';
COMMENT ON COLUMN topic.id IS '自增话题编号';
COMMENT ON COLUMN topic.chapter_id IS '所属章节，关联 chapter.id';
COMMENT ON COLUMN topic.title IS '话题名称';
COMMENT ON COLUMN topic.description IS '必填的简短说明，描述话题内容，不预设开场问题或追问';
COMMENT ON COLUMN topic.sort_order IS '章节内的话题展示顺序';
COMMENT ON COLUMN topic.is_enabled IS '是否启用';
