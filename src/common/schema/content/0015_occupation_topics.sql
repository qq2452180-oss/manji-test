ALTER TABLE topic ADD COLUMN owner_user_id BIGINT REFERENCES users(id) ON DELETE RESTRICT;

COMMENT ON COLUMN topic.owner_user_id IS '职业补充话题的所属用户；为空表示公共话题';
