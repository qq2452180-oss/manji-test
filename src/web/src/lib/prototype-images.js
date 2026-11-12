const pictures = {
  'origins/hometown': {
    src: new URL('../assets/prototype-memories/hometown.webp', import.meta.url).href,
    alt: '傍晚的老巷里，灰瓦房屋旁有一段石阶。',
    caption: '老巷里的傍晚',
  },
  'childhood/playmates_and_play': {
    src: new URL('../assets/prototype-memories/paper-boats.webp', import.meta.url).href,
    alt: '几只手折的小纸船漂在雨后的浅浅积水里。',
    caption: '雨后的小纸船',
  },
  'livelihood/main_work': {
    src: new URL('../assets/prototype-memories/shop.webp', import.meta.url).href,
    alt: '阳光照进朴素的文具店，木货架上摆着本子和纸品。',
    caption: '小店的日常',
  },
  'family_and_relationships/shared_daily_life': {
    src: new URL('../assets/prototype-memories/family-table.webp', import.meta.url).href,
    alt: '温暖灯光下，家里的饭桌摆着家常菜和几副碗筷。',
    caption: '一家人的饭桌',
  },
};

// Static demo illustrations only; no uploads, account photos, or remote URLs.
export function getPrototypeStoryImage(chapterId, contentId) {
  const picture = pictures[`${chapterId}/${contentId}`];
  return picture ? { ...picture, width: 1200, height: 800 } : null;
}
