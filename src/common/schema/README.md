# 当前版本数据库结构

这里保存按编号执行的数据库 SQL。0001–0008 是原始建表基线；已发布文件保持不变，后续字段和表通过新增编号 SQL 增量升级。

| 模块 | 执行顺序及文件 | 用途 |
| --- | --- | --- |
| 账号 | `account/0001_users.sql` | 用户、登录凭证、体验身份 |
| 访谈 | `interview/0002_interview_sessions.sql` | 会话、完整消息上下文、消息编号约束 |
| 访谈 | `interview/0003_media.sql` | 图片归属和文件路径 |
| 记忆 | `memory/0004_user_profiles.sql` | 用户画像 |
| 记忆 | `memory/0005_life_events.sql` | 经历索引 |
| 内容 | `content/0006_chapter.sql` | 章节名称、排序及启用状态 |
| 内容 | `content/0007_story.sql` | 故事、摘要、章节关联及记忆处理状态 |
| 内容 | `content/0008_topic.sql` | 话题名称、必填简短说明、所属章节、排序及启用状态 |
| 内容 | `content/0009_story_revisions.sql` | 故事版本和更新时间、补充快照与独立处理进度 |
| 内容 | `content/0010_biography.sql` | 每个用户的传记全文和更新时间 |
| 访谈 | `interview/0011_rtc_calls.sql` | 旧通话元数据表；保留迁移历史，当前 RTC 不使用 |

按全局文件编号执行，不能按模块名称排序。会话建表文件同时创建消息编号校验函数；故事依赖用户、章节和经历表，话题依赖章节表。章节和话题使用自增整数编号，不设 `code` 字段；话题不保存固定开场问题或参考追问。

## 初始化与检查

在项目根目录运行，使用已安装项目依赖的 Python：

```sh
python src/tools/run_sql.py init --database manji_v2
python src/tools/run_sql.py check --database manji_v2
```

工具读取 `src/.env` 的 `MANJILU_DATABASE_URL`（运行环境优先）。`--database` 沿用主机、端口和账号，只替换本次连接的数据库名，不修改配置文件。目标数据库须事先创建，并允许该账号建表。

`init` 在同一事务内建立全部结构和 `src_schema_migrations` 初始化记录；失败时整体回滚。相同文件重复初始化不会重建表。`check` 只读校验记录和全部业务表的必要字段。已有登记数据库运行 `migrate`，先检查已安装文件的校验和，再以事务追加未安装的编号 SQL。0009 不重建故事或访谈，不改变已有正文和来源；现有故事从版本 1 开始。

0010 只创建 `biography` 表，不修改已有故事和访谈，也不调用模型。用户明确结束并要求成文后，业务流程读取旧传记、融合本次故事并保存全文。已有用户首次融合时，以现有故事组成初始旧稿。

0011 创建的 `rtc_calls` 表已停止使用，SQL 文件保留以兼容已登记的迁移校验和。当前 RTC 只在单进程内存中管理通话，消息由现有访谈服务保存；重启后重新拨打，不恢复旧通话。就绪检查不再要求 `rtc_calls` 表存在，本次代码清理不删除已有数据库中的表或数据。

基线 SQL 不预置业务数据。初始化后的业务表均为空，包括章节和话题表；目录内容单独导入。

## 后续修改

已安装的 SQL 不再修改；新增结构放入连续编号文件。`migrate` 校验历史并仅执行新增文件，整个升级失败会回滚。已有库升级前备份，在隔离测试库验证旧数据和重复执行；`check` 要求结构与完整迁移记录一致。工具不接管未登记的非空数据库。

```sh
python src/tools/run_sql.py migrate --database manji_v2
python src/tools/run_sql.py check --database manji_v2
```

需要手工执行单张表时，可运行 `python src/tools/run_sql.py` 交互选择，或指定 `--file memory/0004_user_profiles.sql`。单文件模式不记录整库初始化状态，`check` 需要通过 `init` 完整初始化的库。
