-- JSONB 的消息 ID 使用正整数 number；其取值范围与 PostgreSQL BIGINT 一致。
CREATE FUNCTION interview_context_ids_valid(value JSONB)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $function$
DECLARE
    message JSONB;
    identifier JSONB;
    numeric_id NUMERIC;
    ids BIGINT[] := ARRAY[]::BIGINT[];
    source_ids BIGINT[] := ARRAY[]::BIGINT[];
    source_id BIGINT;
BEGIN
    IF value IS NULL OR jsonb_typeof(value) <> 'array' THEN
        RETURN FALSE;
    END IF;
    FOR message IN SELECT item FROM jsonb_array_elements(value) AS entry(item)
    LOOP
        identifier := message #> '{data,id}';
        IF jsonb_typeof(message) <> 'object'
            OR jsonb_typeof(message->'data') IS DISTINCT FROM 'object'
            OR jsonb_typeof(identifier) IS DISTINCT FROM 'number'
            OR identifier::TEXT !~ '^[0-9]+$'
        THEN
            RETURN FALSE;
        END IF;
        numeric_id := identifier::TEXT::NUMERIC;
        IF numeric_id < 1 OR numeric_id > 9223372036854775807 THEN
            RETURN FALSE;
        END IF;
        IF numeric_id::BIGINT = ANY(ids) THEN
            RETURN FALSE;
        END IF;
        ids := array_append(ids, numeric_id::BIGINT);
        identifier := message #> '{data,additional_kwargs,source_message_id}';
        IF identifier IS NOT NULL AND identifier <> 'null'::JSONB THEN
            IF jsonb_typeof(identifier) <> 'number' OR identifier::TEXT !~ '^[0-9]+$' THEN
                RETURN FALSE;
            END IF;
            numeric_id := identifier::TEXT::NUMERIC;
            IF numeric_id < 1 OR numeric_id > 9223372036854775807 THEN
                RETURN FALSE;
            END IF;
            source_ids := array_append(source_ids, numeric_id::BIGINT);
        END IF;
    END LOOP;
    FOREACH source_id IN ARRAY source_ids
    LOOP
        IF NOT source_id = ANY(ids) THEN
            RETURN FALSE;
        END IF;
    END LOOP;
    RETURN TRUE;
END;
$function$;

CREATE TABLE interview_sessions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    resume_mode TEXT CHECK (resume_mode IN ('text', 'photo', 'voice')),
    context JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(context) = 'array'),
    create_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    update_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finish_time TIMESTAMPTZ,
    CONSTRAINT interview_sessions_context_ids_check
        CHECK (interview_context_ids_valid(context))
);

CREATE INDEX idx_interview_sessions_user_update_time
    ON interview_sessions (user_id, update_time DESC);

COMMENT ON TABLE interview_sessions IS '访谈会话及按发生顺序保存的用户与 AI 问答';
COMMENT ON COLUMN interview_sessions.id IS '自增会话编号，传给 LangGraph 时转换为字符串 thread_id';
COMMENT ON COLUMN interview_sessions.user_id IS '会话所属用户，关联 users.id';
COMMENT ON COLUMN interview_sessions.resume_mode IS
    '继续访谈的界面模式：text 文字、photo 图片加语音、voice 语音；NULL 表示尚未选择';
COMMENT ON COLUMN interview_sessions.context IS
    'LangChain 消息数组；data.id 为会话内唯一的正 BIGINT JSON 整数，source_message_id 引用同一会话消息；保留正文和图片引用';
COMMENT ON COLUMN interview_sessions.create_time IS '会话创建时间';
COMMENT ON COLUMN interview_sessions.update_time IS '最近一次保存输入、回复或结束动作的时间，由应用写入时更新';
COMMENT ON COLUMN interview_sessions.finish_time IS '图接受结束访谈动作的时间，不代表故事生成完成';
