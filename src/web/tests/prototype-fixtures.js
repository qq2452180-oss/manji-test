import legacyStories from '../src/content/prototype-stories.json';
import { PROTOTYPE_STORAGE_KEY, PROTOTYPE_SEED_REVISION } from '../src/lib/prototype-state.js';

// Isolate the original playback/reading regression cases from newer sample content.
// Default initialization, migration and reset are tested against the full sample set.
export function legacyPrototypeSnapshot() {
  return {
    version: 1, seedRevision: PROTOTYPE_SEED_REVISION, selectedChapterId: 'L1',
    stories: legacyStories.map((story, index) => {
      const date = new Date(Date.UTC(2026, 0, index + 1, 8)).toISOString();
      return { ...structuredClone(story), createdAt: date, updatedAt: date };
    }),
    sessions: [],
  };
}

export function useLegacyPrototypeSnapshot() {
  const state = legacyPrototypeSnapshot();
  sessionStorage.setItem(PROTOTYPE_STORAGE_KEY, JSON.stringify(state));
  return state;
}
