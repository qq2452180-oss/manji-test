"""应用启动入口。

在 PyCharm 中直接运行本文件，或执行 python src/main.py。
本地地址：http://127.0.0.1:8003
也支持：python -m uvicorn src.main:app --host 127.0.0.1 --port 8003
"""

import sys
from pathlib import Path

# 直接运行文件时，使用项目根目录导入，避免 src/langgraph 遮蔽第三方包。
if not __package__:
    source_directory = Path(__file__).resolve().parent
    sys.path[:] = [path for path in sys.path if Path(path).resolve() != source_directory]
    sys.path.insert(0, str(source_directory.parent))

from src.api.app import create_app

app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8004)
