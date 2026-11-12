CREATE TABLE rtc_calls (
    call_id TEXT PRIMARY KEY CHECK (call_id ~ '^[a-f0-9]{32}$'),
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    session_id BIGINT NOT NULL REFERENCES interview_sessions(id) ON DELETE RESTRICT,
    client_request_id TEXT NOT NULL,
    metadata JSONB NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
    UNIQUE (user_id, session_id, client_request_id)
);

CREATE UNIQUE INDEX idx_rtc_calls_live_session ON rtc_calls (session_id)
    WHERE metadata->>'status' IN ('PREPARED', 'STARTING', 'ACTIVE', 'STOPPING')
       OR metadata->>'turn_pending' = 'true';
CREATE UNIQUE INDEX idx_rtc_calls_task ON rtc_calls ((metadata->>'task_id'))
    WHERE metadata->>'task_id' IS NOT NULL;

COMMENT ON TABLE rtc_calls IS '通话连接与腾讯任务元数据；重启后停止旧任务再重拨，不保存凭证或问答正文';
COMMENT ON COLUMN rtc_calls.metadata IS '状态、版本、房间和任务标识、时间及固定错误提示；LLM请求去重仍只在当前进程有效';
