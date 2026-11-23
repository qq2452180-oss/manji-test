# 本地命令发布

## 平时只运行这个入口

先打开 Mac 上的 Docker Desktop，再打开 **Mac 的终端**，执行：

```sh
cd /Users/a1024/Documents/workspace/manji
./deploy.sh
```

屏幕会显示中文菜单，输入数字并回车：

| 选择 | 什么时候用 | 会做什么 |
| --- | --- | --- |
| 1 | 改好代码、已在本地 git commit，准备更新网站 | 自动测试、打包、上传并更新线上应用 |
| 2 | 想知道服务器现在是否正常、运行哪个版本 | 查看状态，不修改网站 |
| 3 | 想把线上应用恢复成上一个版本 | 执行回滚 |
| 4 | 第一次使用，还没配置本机到服务器的发布入口 | 生成安装包，显示服务器上需要执行的一次性安装步骤 |
| 0 或直接回车 | 暂时不操作 | 退出 |

**第一次先选 4；完成服务器安装后，以后发布通常选 1。** 选择 4 只是在本机准备安装包，需要按屏幕提示在服务器完成安装。`git commit` 是把代码保存为一个本地版本，不需要上传 GitHub。看到“工作区有修改”的提示时，先完成本地提交再发布。

## 这些文件各自做什么

| 文件 | 用途 | 需要手动运行吗 |
| --- | --- | --- |
| 根目录 `deploy.sh` | 统一入口，显示中文菜单 | **日常只运行它** |
| `deploy/production/release.py` | 在 Mac 上组织测试、构建、打包和上传 | 不需要，入口会调用 |
| `deploy/production/deploy.py` | 在服务器上更新应用、检查健康、回滚 | 不需要，本机命令通过 SSH 调用 |
| `deploy/production/image_archive.py` | 检查镜像包是否完整，防止坏包上线 | 不需要，自动调用 |
| `deploy/production/install-server.sh` | 首次给服务器安装发布入口 | 仅首次配置或更新服务器脚本时按提示运行 |
| `deploy/production/tests/` | 用来验证发布脚本的测试代码 | 不需要，检查流程会运行 |
| 本文 `README.md` | 操作说明 | 阅读即可 |
| `.release/` | 自动生成的安装包、镜像包和本地测试环境 | 不需要逐个执行 |

下面是首次配置步骤和需要分步操作时的完整命令。日常使用上面的菜单即可。

## 工作流程

在项目根目录运行 `./deploy.sh`。流程是：本机测试 → 本机构建 `linux/amd64` 镜像 → 压缩打包 → SSH 上传 → 服务器导入镜像 → 上线前检查 → 更新应用 → 健康检查。无需 GitHub Actions、GHCR 或 TCR，也无需把代码 push 到远程后才能发布。

Git 仍用于记录版本。仓库中的 GitHub CI/CD workflow 已移除；**提交并推送这次删除后，GitHub 上才会停止后续自动运行**。普通代码提交不会自动发布生产环境。

## 本机要求

- Docker Desktop 已启动，支持 Buildx 和 `linux/amd64`（Apple Silicon Mac 也可以）。
- Node.js >= 24.12、npm、Python 3.11、Git、SSH。入口脚本可以由系统 Python 3.9+ 启动。
- 测试解释器按 `MANJI_PYTHON`、PATH 中的 `python3.11`、本机已有的 `/opt/anaconda3/envs/manji/bin/python` 顺序查找；只接受 Python 3.11。测试依赖自动安装到项目 `.release/venv`，不改现有开发环境。
- 首次构建需要连接 npm、PyPI 和 Docker 基础镜像仓库；后续复用本机下载与构建缓存。本流程省去应用镜像仓库，不保证基础依赖下载不受网络影响。

所有生成文件位于 `.release/`，已加入 Git 忽略。保留足够磁盘空间供源码快照、Docker 缓存及镜像归档使用。

## 首次配置服务器（只做一次）

本机执行：

```sh
./deploy.sh init
```

这会生成：

- 专用私钥 `~/.ssh/manji_release_ed25519`，仅留在本机，**不要上传**。已有同名密钥不会覆盖。
- `.release/server-setup.tar.gz`，只含服务器脚本和公钥。

用已登录的腾讯云浏览器终端文件管理器，将 `server-setup.tar.gz` 上传到服务器 `/root`，然后在**服务器终端**执行：

```sh
cd /root
tar -xzf server-setup.tar.gz
bash manji-release-setup/install-server.sh
```

安装器先备份原部署脚本、配置、版本状态和 SSH 公钥列表，再安装新脚本并追加专用受限公钥，不重启应用。它保留其他登录公钥；新公钥只能上传镜像包、发布、回滚和查看状态，不能执行任意 shell/SCP。服务器需要现有 Docker Compose、Python 3 和 `flock`。

回到**本机终端**验证：

```sh
./deploy.sh status
```

固定服务器为 `root@152.136.149.132`，主机公钥使用仓库内 `known_hosts`，不会跳过主机身份验证。更换服务器必须另行核对配置和主机公钥。指定其他专用密钥时，所有命令将 `--key` 放在子命令前：`./deploy.sh --key ~/.ssh/another_release_key status`。

## 日常发布

先在本地提交本次代码，不必 push：

```sh
git add <本次修改的文件>
git commit -m "本次修改说明"
./deploy.sh publish
```

`publish` 默认要求工作区干净。它从 Git HEAD 导出独立源码快照，测试和构建都使用同一个快照，不会把本地 `.env`、上传文件或工作区未提交改动带进镜像。打包期间继续编辑工作区不会改变这次构建的源码。

也可以分步执行：

```sh
./deploy.sh check                  # 检查当前工作区，允许未提交修改
./deploy.sh package                # 对已提交源码重新测试、构建和打包
./deploy.sh upload                 # 只上传最近成功打包的镜像，不更新应用
./deploy.sh deploy --uploaded      # 部署已上传的同一镜像包
./deploy.sh status                 # 查看版本、healthy 和 drift
```

通常打包后直接执行 `./deploy.sh deploy` 即可，它会完成上传和部署。打包成功后打印 `release.json` 路径，也记录在 `.release/latest`；失败的打包不会覆盖该指针。

明确选择某个已提交版本（会忽略当前工作区未提交的修改）：

```sh
./deploy.sh package --revision <commit-SHA>
./deploy.sh deploy .release/packages/<发布目录>/release.json
```

## 测试与上线检查

每次打包都执行前端测试和构建、Python 依赖一致性检查、完整后端测试（含隔离的 PostgreSQL 临时测试库），然后启动真实镜像检查数据库结构、健康接口、页面资源及媒体卷读写。测试库只绑定本机随机端口，完成后删除；不使用生产数据库。

镜像使用唯一发布标签并记录 config SHA256，直接从 Buildx 导出完整 Docker 归档；逐层校验镜像内容，防止缺失缓存层的归档被当作成功包。上传前后还会校验压缩包大小和 SHA256。单包上限 2 GiB，单次上传限时 20 分钟，上传失败最多从头重试三次（不是断点续传）。上传失败不会开始切换应用。

服务器沿用 `/root/manji-src/deploy/src/compose.yml`、`compose.env` 和现有数据卷。上线前先运行临时候选容器，校验数据库版本与健康状态，媒体挂载只读；通过后只重建 `app`，验证线上 `https://manjilu.cn/api/ready` 和 `/web/index.html`。应用切换会短暂影响请求和进行中的语音通话，请选低峰时间。

数据库和网关容器保持不变。部署不自动执行数据库迁移；结构不兼容的版本会在切换前失败，需单独安排迁移。

## 回滚和异常恢复

```sh
./deploy.sh rollback
./deploy.sh status
```

上线后健康检查失败会尝试自动恢复上一版；手动 `rollback` 也使用服务器 `cd-state.json` 记录的上一版。只回退应用，不回退数据库。服务器保留原 GHCR 发布记录和上一版镜像，首次本地发布可以沿用它们回滚。

如果 SSH 在部署过程中断开，先运行 `status` 查看真实结果，避免误判：服务器会尽量继续完成已开始的切换。已上传成功的包可通过 `deploy --uploaded <release.json>` 继续部署，避免再次上传。`healthy: true` 且 `drift: false` 表示健康状态与配置记录一致；还需核对输出中的 revision 是否为本次版本。

发布包保存在服务器 `/root/manji-src/deploy/src/releases/`；本机包在 `.release/packages/`。不自动删除旧包或镜像，以便排查和回滚。清理前保留当前和上一版镜像；不要直接运行全量 Docker 清理命令。服务器断电、磁盘故障或强制终止进程可能需要人工恢复。

更新服务器脚本时，重新 `init` 生成安装包并运行安装器。普通应用发布不会替换服务器脚本。
