#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
test "$(id -u)" -eq 0 || { echo '请在服务器上以 root 运行。' >&2; exit 1; }
test -f /root/manji-src/deploy/src/compose.yml
test -f /root/manji-src/deploy/src/compose.env
docker compose version
python3 -m py_compile deploy.py image_archive.py database_backup.py
ssh-keygen -lf release-key.pub
exec 9>/run/lock/manji-cd.lock
flock -n 9 || { echo '已有发布正在执行，请稍后重试。' >&2; exit 1; }
manji_backup=$(mktemp -d /root/manji-release-setup-backup.XXXXXX)
for manji_file in deploy.py image_archive.py database_backup.py compose.env cd-state.json database-upgrade.json; do
    if [ -f "/root/manji-src/deploy/src/$manji_file" ]; then
        cp -p "/root/manji-src/deploy/src/$manji_file" "$manji_backup/"
    fi
done
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
cp -p /root/.ssh/authorized_keys "$manji_backup/authorized_keys"
install -m 600 image_archive.py /root/manji-src/deploy/src/image_archive.py
install -m 600 database_backup.py /root/manji-src/deploy/src/database_backup.py
install -m 700 deploy.py /root/manji-src/deploy/src/deploy.py
manji_key_line="restrict,command=\"/usr/bin/python3 /root/manji-src/deploy/src/deploy.py\" $(cat release-key.pub)"
if ! grep -qxF "$manji_key_line" /root/.ssh/authorized_keys; then
    printf '\n%s\n' "$manji_key_line" >> /root/.ssh/authorized_keys
fi
chmod 600 /root/.ssh/authorized_keys
flock -u 9
python3 /root/manji-src/deploy/src/deploy.py status
printf '安装完成；备份：%s\n' "$manji_backup"
