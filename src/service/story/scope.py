"""新全局故事可以无章节；历史缺章记录仍按原兼容路径处理。"""


def readable_story_sql(alias: str = "story") -> str:
    # alias 来自程序中的表名，不接受请求参数。
    return f"""({alias}.chapter_id IS NOT NULL OR EXISTS (
        SELECT 1 FROM interview_sessions AS source_session
        WHERE source_session.user_id = {alias}.user_id
          AND source_session.id::text = {alias}.source_session_id
          AND (SELECT entry.message #>> '{{data,additional_kwargs,interview_context,interview_scope}}'
               FROM jsonb_array_elements(source_session.context) WITH ORDINALITY AS entry(message, position)
               WHERE entry.message->>'type' = 'ai' ORDER BY entry.position LIMIT 1) = 'global'
    ))"""
