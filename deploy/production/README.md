# 生产发布

代码推送 `main` 后，先等待 **CI** 三个任务全部通过，再到 [Actions → Deploy](https://github.com/qq2452180-oss/manji-test/actions/workflows/cd.yml) 点击 **Run workflow**：

- 分支选择 `main`，`action` 选择 `deploy`，`revision` 留空即可发布本次 main 版本。
- 发布指定历史版本时，填写该版本完整的 40 位 commit SHA；该版本必须在 main 上通过 CI。
- 回到上一版：`action` 选择 `rollback`，忽略 `revision`。

发布只重建应用容器，会短暂影响请求和进行中的语音通话，请在低峰操作。发布不会自动执行数据库迁移；涉及数据库结构变化的版本必须另行安排迁移，否则发布前检查会拒绝切换。

## 服务器上的最小配置

沿用 `/root/manji-src/deploy/src/compose.yml`、现有环境文件和数据卷。新增文件只有同目录下的 `deploy.py`、首次发布后生成的 `cd-state.json`，以及 `/run/lock/manji-cd.lock` 锁文件。

`deploy.py` 拉取固定 digest 的镜像，先启动临时候选容器验证数据库版本和健康状态，再只修改 `compose.env` 中的 `MANJI_APP_IMAGE` 并重建 `app`。切换失败时恢复旧镜像。PostgreSQL、Nginx 容器和媒体卷保持原有配置；临时容器验证完自动删除。

服务器保留当前和上一版镜像用于回滚，不自动清理旧镜像或数据库。`cd-state.json` 记录的是应用版本，不能用来回退数据库。

GitHub 仓库仅需要一个 Actions Secret：`MANJI_DEPLOY_SSH_KEY`。对应公钥使用以下 SSH 限制，只允许执行脚本规定的发布、回滚和状态命令：

```text
restrict,command="/usr/bin/python3 /root/manji-src/deploy/src/deploy.py" <部署公钥>
```

服务器主机公钥固定在 `known_hosts`；更换服务器时必须重新核对。GHCR 镜像目前可匿名拉取，服务器无需安装 Git、Node、Actions Runner 或保存 GitHub 访问令牌。

## 现场检查

在服务器终端执行：

```sh
python3 /root/manji-src/deploy/src/deploy.py status
python3 /root/manji-src/deploy/src/deploy.py rollback
```

如果脚本报告配置与运行版本不一致，先核对实际容器和 `compose.env`，避免覆盖人工操作。服务器断电、磁盘故障或强制终止进程可能需要人工恢复。更新部署脚本本身时，应审核本仓库文件后单独安装；普通应用发布不会改动服务器脚本。
