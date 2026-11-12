"""补充会话与同一故事的版本化成文结果；数据库事务承担幂等和并发保护。"""

from psycopg.types.json import Jsonb


class StoryVersionConflict(ValueError):
    pass


def selected_topic_from_context(context):
    opening = next((message for message in context if message.get('type') == 'ai'), None)
    topic = ((opening or {}).get('data', {}).get('additional_kwargs', {})
             .get('interview_context', {}).get('selected_topic'))
    if not isinstance(topic, dict) or type(topic.get('id')) is not int:
        return None
    return topic


def story_snapshot(story):
    return {key: story[key] for key in (
        'story_id', 'title', 'body', 'chapter_id', 'source_session_id', 'photo_layout',
        'summary', 'profile_processed', 'life_event_processed', 'version',
    )}


class StoryRevisionRepository:
    def start_supplement(self, user_id, story_id, topic_id, resume_mode=None):
        """同一事务建立补充会话与快照；重复点击复用唯一的活动会话。"""
        with self._connect() as connection:
            story = connection.execute(
                'SELECT *, id AS story_id FROM story WHERE id = %s AND user_id = %s '
                'AND chapter_id IS NOT NULL FOR UPDATE', (story_id, user_id),
            ).fetchone()
            if story is None:
                raise LookupError('故事不存在')
            source = connection.execute(
                'SELECT context FROM interview_sessions WHERE id::text = %s AND user_id = %s',
                (story['source_session_id'], user_id),
            ).fetchone()
            topic = selected_topic_from_context(source['context']) if source else None
            if topic is None or topic.get('id') != topic_id:
                raise ValueError('故事与所选话题不匹配，请从原故事重新打开')
            active = connection.execute(
                "SELECT * FROM story_revisions WHERE story_id = %s AND user_id = %s AND status <> 'completed'",
                (story_id, user_id),
            ).fetchone()
            if active:
                return active, False
            if not (story['profile_processed'] and story['life_event_processed'] and (story['summary'] or '').strip()):
                raise ValueError('原故事尚有整理步骤未完成，请先继续整理')
            session = connection.execute(
                'INSERT INTO interview_sessions (user_id, resume_mode) VALUES (%s, %s) RETURNING id',
                (user_id, resume_mode),
            ).fetchone()
            snapshot = story_snapshot(story)
            revision = connection.execute(
                'INSERT INTO story_revisions (user_id, story_id, source_session_id, base_version, '
                'base_story, original_story, photo_layout) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                (user_id, story_id, str(session['id']), story['version'], Jsonb(snapshot),
                 Jsonb(snapshot), Jsonb(story['photo_layout'])),
            ).fetchone()
            return revision, True

    def get_revision_by_session(self, user_id, source_session_id):
        with self._connect() as connection:
            return connection.execute(
                'SELECT * FROM story_revisions WHERE user_id = %s AND source_session_id = %s',
                (user_id, str(source_session_id)),
            ).fetchone()

    def get_revision(self, user_id, revision_id):
        with self._connect() as connection:
            return connection.execute(
                'SELECT * FROM story_revisions WHERE user_id = %s AND id = %s',
                (user_id, revision_id),
            ).fetchone()

    def mark_revision_pending(self, user_id, revision_id):
        with self._connect() as connection:
            connection.execute(
                "UPDATE story_revisions SET status = 'pending', update_time = CURRENT_TIMESTAMP "
                "WHERE id = %s AND user_id = %s AND status = 'interviewing'", (revision_id, user_id),
            )

    def rebase_revision(self, user_id, revision_id):
        """只重置未应用候选；保留初始快照和原始问答。"""
        with self._connect() as connection:
            connection.execute(
                'SELECT story.id FROM story JOIN story_revisions AS revision ON revision.story_id = story.id '
                'WHERE revision.id = %s AND revision.user_id = %s AND story.user_id = %s FOR UPDATE OF story',
                (revision_id, user_id, user_id),
            )
            revision = connection.execute(
                'SELECT * FROM story_revisions WHERE id = %s AND user_id = %s FOR UPDATE',
                (revision_id, user_id),
            ).fetchone()
            if revision is None or revision['status'] != 'conflict':
                raise ValueError('当前补充不需要重新整理')
            story = connection.execute(
                'SELECT *, id AS story_id FROM story WHERE id = %s AND user_id = %s FOR UPDATE',
                (revision['story_id'], user_id),
            ).fetchone()
            return connection.execute(
                "UPDATE story_revisions SET base_version = %s, base_story = %s, title = NULL, body = NULL, "
                "photo_layout = %s, attempt = attempt + 1, status = 'pending', update_time = CURRENT_TIMESTAMP "
                'WHERE id = %s RETURNING *',
                (story['version'], Jsonb(story_snapshot(story)), Jsonb(story['photo_layout']), revision_id),
            ).fetchone()

    def apply_revision(self, user_id, revision_id, attempt, title, body):
        """保存候选后校验版本；故事更新及 applied 标记原子提交。"""
        conflict = False
        with self._connect() as connection:
            connection.execute(
                'SELECT story.id FROM story JOIN story_revisions AS revision ON revision.story_id = story.id '
                'WHERE revision.id = %s AND revision.user_id = %s AND story.user_id = %s FOR UPDATE OF story',
                (revision_id, user_id, user_id),
            )
            revision = connection.execute(
                'SELECT * FROM story_revisions WHERE id = %s AND user_id = %s FOR UPDATE',
                (revision_id, user_id),
            ).fetchone()
            if revision is None:
                raise ValueError('补充记录不存在')
            if revision['applied_version'] is not None:
                return revision
            if revision['attempt'] != attempt:
                raise StoryVersionConflict('整理依据已更新，请读取最新进度')
            if revision['status'] == 'conflict':
                raise StoryVersionConflict('故事已被修改，补充内容已保留，请基于最新版重新整理')
            # Existing photo references are preserved at the end after prose is reorganized.
            layout = [{**item, 'after_paragraph': None} for item in revision['base_story']['photo_layout']]
            if revision['title'] is not None:
                title, body, layout = revision['title'], revision['body'], revision['photo_layout']
            else:
                connection.execute(
                    'UPDATE story_revisions SET title = %s, body = %s, photo_layout = %s WHERE id = %s',
                    (title, body, Jsonb(layout), revision_id),
                )
            story = connection.execute(
                'UPDATE story SET title = %s, body = %s, photo_layout = %s, version = version + 1, '
                'updated_time = CURRENT_TIMESTAMP WHERE id = %s AND user_id = %s AND version = %s RETURNING version',
                (title, body, Jsonb(layout), revision['story_id'], user_id, revision['base_version']),
            ).fetchone()
            if story is None:
                connection.execute(
                    "UPDATE story_revisions SET status = 'conflict', update_time = CURRENT_TIMESTAMP WHERE id = %s",
                    (revision_id,),
                )
                conflict = True
            else:
                revision = connection.execute(
                    "UPDATE story_revisions SET status = 'applied', applied_version = %s, "
                    'update_time = CURRENT_TIMESTAMP WHERE id = %s RETURNING *',
                    (story['version'], revision_id),
                ).fetchone()
        if conflict:
            raise StoryVersionConflict('故事已被修改，补充内容已保留，请基于最新版重新整理')
        return revision

    @staticmethod
    def revision_result(revision):
        return {
            'story_id': revision['story_id'], 'target_story_id': revision['story_id'],
            'revision_id': revision['id'], 'revision_status': revision['status'],
            'title': revision['title'], 'body': revision['body'],
            'chapter_id': revision['base_story']['chapter_id'],
            'source_session_id': revision['source_session_id'], 'photo_layout': revision['photo_layout'],
            'summary': revision['summary'], 'profile_processed': revision['profile_processed'],
            'life_event_processed': revision['life_event_processed'],
        }

    def get_active_supplement(self, user_id, story_id):
        with self._connect() as connection:
            row = connection.execute(
                'SELECT revision.source_session_id AS session_id, '
                "CASE WHEN session.finish_time IS NULL THEN 'in_progress' ELSE 'organizing' END AS status "
                'FROM story_revisions AS revision JOIN interview_sessions AS session '
                'ON session.id::text = revision.source_session_id AND session.user_id = revision.user_id '
                "WHERE revision.user_id = %s AND revision.story_id = %s AND revision.status <> 'completed'",
                (user_id, story_id),
            ).fetchone()
        return row

    def list_story_sessions(self, user_id, story_id):
        with self._connect() as connection:
            original = connection.execute(
                'SELECT session.id::text AS session_id, session.finish_time FROM story '
                'JOIN interview_sessions AS session ON session.id::text = story.source_session_id '
                'AND session.user_id = story.user_id WHERE story.id = %s AND story.user_id = %s',
                (story_id, user_id),
            ).fetchone()
            supplements = connection.execute(
                "SELECT source_session_id AS session_id, 'supplement' AS kind, "
                "CASE WHEN status = 'interviewing' THEN 'in_progress' WHEN status = 'completed' THEN 'completed' "
                "ELSE 'organizing' END AS status FROM story_revisions WHERE story_id = %s AND user_id = %s ORDER BY id",
                (story_id, user_id),
            ).fetchall()
        sources = []
        if original:
            result = self.get_by_session(user_id, original['session_id'])
            complete = result and result['profile_processed'] and result['life_event_processed'] and (result['summary'] or '').strip()
            sources.append({'session_id': original['session_id'], 'kind': 'original',
                            'status': 'in_progress' if original['finish_time'] is None else 'completed' if complete else 'organizing'})
        return sources + supplements
