import scenarios from '../content/prototype-scenarios.json';

// 固定的虚构演示素材，不请求接口，也不读取或修改用户数据。
export const prototypeScenarios = scenarios;

export function getPrototypeScenario(chapterId = 'childhood', contentId = 'childhood_memory') {
  return scenarios.find((scenario) => scenario.chapterId === chapterId && scenario.contentId === contentId) || null;
}
