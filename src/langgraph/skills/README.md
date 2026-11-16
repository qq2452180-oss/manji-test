# 小暖访谈 Skills 接入

在 `src/.env` 设置 `MANJI_INTERVIEW_MODE=agent`，重启后端即可使用智能体版访谈。
未配置时的代码默认值为 `legacy`；生产 Docker 镜像显式设置为 `agent`。
需要切回原访谈实现时，在运行环境设置 `MANJI_INTERVIEW_MODE=legacy` 并重启。
旧提示词保持原样。
该开关在构建工作流时读取，文字、语音转写和图片访谈共用同一个 `interview` 节点。

智能体使用 `prompt/interview/interview_agent_system.md`，先获得本目录下各技能的
`name` / `description`，再通过 `read_skill(name)` 按需读取完整技能。

保留 9 个技能目录，每个目录只有一个 `SKILL.md`：文件顶部声明 `name` 和
`description`，正文集中说明适用范围、核心判断、必要方法和边界。技能之间保留
职责区别，单项内部合并去重，不维护固定场景问答或措辞替换清单。

工具只接受技能名称，不接受路径或资源选择参数。技能正文不预先全量注入；
每次读取文件最新内容。修改技能文字无需重启，修改 Python 读取接口后需要重启后端。

每轮最多进行三轮工具调用，然后要求模型给出最终回复。所有调用共享现有文字或
语音的总等待预算；失败沿现有重试流程处理。业务历史只保存最终回复，工具消息
不进入聊天记录和传记素材。下一轮按需重新读取技能，不保存额外的智能体会话。

这次接入提供访谈方法读取与应用；原有记忆、成文、存储和语音服务继续承担业务。
技能中涉及删除、用途隔离或控制麦克风的要求不会因为读取文件而自动成为系统功能。

测试：`python -m pytest src/tests/test_interview_agent.py src/tests/test_interview_skills.py src/tests/test_qwen_agent.py -q`
