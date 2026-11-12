# 演示回忆配图

这些图片由内置 `image_gen` 工具生成，用于虚构演示故事；不是用户照片。页面统一显示“AI 演示配图”。图片通过本地静态资源加载，不读取账号照片、不上传图片。

所有交付图均为 1200 × 800 WebP。生成的 PNG 原件保留在 Codex 的 generated_images 目录，项目资源仅做尺寸和格式转换。

| 文件 | 主题 | 对应片段 |
| --- | --- | --- |
| `hometown.webp` | 傍晚老巷、灰瓦、木门与石阶 | origins / hometown |
| `paper-boats.webp` | 雨后积水中的手折纸船 | childhood / playmates_and_play |
| `shop.webp` | 阳光下的朴素文具店 | livelihood / main_work |
| `family-table.webp` | 灯光下的家常饭桌 | family_and_relationships / shared_daily_life |

## 老巷与纸船

这两张图来自本次任务前段的内置图像生成结果。交付文件已保留并检查。原始逐字提示词尚未取回；表中的场景描述仅为素材说明，不冒充原始提示词。

## 文具店

原件：`/Users/a1024/.codex/generated_images/01a1a48d-7721-7080-8dab-62b98d1ced45/exec-d57e429f-2ac0-44a5-a23d-acc8600c7ecc.png`

工具参数：`transparent_background: false`

实际提交提示词：

```text
Use case: photorealistic-natural. Asset type: landscape inline illustration for a Chinese personal memoir demo website. Create one warm, natural documentary-style image of the interior of a modest neighborhood stationery shop in China: simple wooden shelves holding neatly stacked exercise notebooks, loose paper and plain pen boxes; a worn wooden counter with a ledger, scissors and a roll of tape; gentle afternoon window light. It should illustrate a humble everyday memory of working in a stationery shop for many years. Understated cream, warm wood brown and muted olive palette, believable slightly worn textures, natural photography rather than glossy advertising. Landscape 3:2 composition, readable details even at small mobile width. No people, no readable lettering, no signs, no logos, no watermark, no collage, no UI. Keep the scene ordinary and lived-in, with no dramatic cinematic effects.
```

## 家庭饭桌

原件：`/Users/a1024/.codex/generated_images/01a1a48d-7721-7080-8dab-62b98d1ced45/exec-6ac1ca3b-ae1e-4c55-bcff-bdf08da7d4e8.png`

工具参数：`transparent_background: false`

实际提交提示词：

```text
Use case: photorealistic-natural. Asset type: landscape inline illustration for a Chinese personal memoir demo website. Create one warm, natural documentary-style image of a modest family dinner table in a lived-in Chinese home. A simple wooden table with three ceramic bowls and chopsticks, two or three ordinary home-cooked dishes such as greens and rice; a gentle warm overhead light and an evening window in the background. The image accompanies a memory of family meals, clearing dishes together, and taking a short walk after dinner. Intimate but restrained everyday atmosphere, cream walls, muted warm wood brown and soft olive tones, believable household textures, natural photography rather than glossy restaurant advertising. Landscape 3:2 composition. No people, no readable writing, no logos, no watermark, no collage, no UI. Avoid an extravagant feast or staged luxury.
```

