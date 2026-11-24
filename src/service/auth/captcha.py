"""将图片验证码绘制为可直接展示的 PNG。"""

from base64 import b64encode
from io import BytesIO
import secrets

from PIL import Image, ImageDraw, ImageFont


def render_captcha(answer: str) -> str:
    image = Image.new("RGB", (168, 60), "#fffaf4")
    draw = ImageDraw.Draw(image)
    for _ in range(3):
        draw.line([(x, 5 + secrets.randbelow(50)) for x in (0, 54, 112, 167)], fill="#dbccbc", width=2)

    font = ImageFont.load_default(size=40)
    for index, digit in enumerate(answer):
        glyph = Image.new("L", (36, 50))
        ImageDraw.Draw(glyph).text((18, 25), digit, font=font, anchor="mm", fill=255, stroke_width=1)
        glyph = glyph.rotate(secrets.randbelow(19) - 9, resample=Image.Resampling.BICUBIC)
        image.paste("#40352b", (7 + 39 * index, 3 + secrets.randbelow(6)), glyph)

    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return "data:image/png;base64," + b64encode(buffer.getvalue()).decode("ascii")
