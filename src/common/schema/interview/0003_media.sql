CREATE TABLE media (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL UNIQUE,
    create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMENT ON COLUMN media.session_id IS '上传时所属的访谈会话 ID';
COMMENT ON COLUMN media.file_path IS '相对于图片存储根目录的文件路径，包含文件名';
