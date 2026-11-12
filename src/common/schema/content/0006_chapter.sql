CREATE TABLE chapter (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT TRUE
);

COMMENT ON TABLE chapter IS '通用人生阶段章节';
COMMENT ON COLUMN chapter.id IS '自增章节编号';
COMMENT ON COLUMN chapter.title IS '章节名称';
COMMENT ON COLUMN chapter.sort_order IS '章节展示顺序';
COMMENT ON COLUMN chapter.is_enabled IS '是否启用；停用时保留章节及历史故事关联';
