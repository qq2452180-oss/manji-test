import topicLibrary from '../content/life-stage-topics.json';
import legacyTemplate from '../content/biography-template.json';

// Keep the source wording and card metadata intact; the map only adapts its shape.
export const lifeMapChapters = topicLibrary.stage_definitions.map(stage => ({
  ...stage,
  title: stage.name,
  core_contents: topicLibrary.cards
    .filter(card => card.stage === stage.id)
    .map(card => ({ ...card, description: card.prompt })),
}));

// Previous demo stories and saved sessions still resolve through their original IDs.
export const prototypeChapters = [...lifeMapChapters, ...legacyTemplate.chapters];

export function findPrototypeChapter(id) {
  return prototypeChapters.find(chapter => chapter.id === id);
}

export function findLifeMapTopic(chapterId, contentId) {
  return lifeMapChapters.find(chapter => chapter.id === chapterId)
    ?.core_contents.find(content => content.id === contentId);
}
