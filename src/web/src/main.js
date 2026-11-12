import { createApp, defineAsyncComponent, h } from 'vue';
import { entryFor } from './lib/entries.js';
import { navigate } from './lib/navigation.js';
import './styles/base.css';

const pages = {
  index: () => import('./pages/HomePage.vue'),
  'prototype-home': () => import('./pages/PrototypeHomePage.vue'),
  'prototype-interview': () => import('./pages/PrototypeInterviewPage.vue'),
  'prototype-story': () => import('./pages/PrototypeStoryPage.vue'),
  'prototype-biography': () => import('./pages/PrototypeBiographyPage.vue'),
  'prototype-chapter': () => import('./pages/PrototypeChapterPage.vue'),
  'prototype-profile': () => import('./pages/PrototypeProfilePage.vue'),
  'prototype-history': () => import('./pages/PrototypeHistoryPage.vue'),
  'prototype-organizing': () => import('./pages/PrototypeOrganizingPage.vue'),
  'prototype-family': () => import('./pages/PrototypeFamilyPage.vue'),
  welcome: () => import('./pages/WelcomePage.vue'),
  login: () => import('./pages/LoginPage.vue'),
  interview: () => import('./pages/InterviewPage.vue'),
  history: () => import('./pages/HistoryPage.vue'),
  organizing: () => import('./pages/OrganizingPage.vue'),
  biography: () => import('./pages/ReadingPage.vue'),
  chapter: () => import('./pages/ReadingPage.vue'),
  story: () => import('./pages/ReadingPage.vue'),
  profile: () => import('./pages/ProfilePage.vue'),
  'profile-edit': () => import('./pages/ProfileEditPage.vue'),
  preview: () => import('./pages/PreviewPage.vue'),
};
const entry = entryFor(location.pathname, location.search);
if (entry.redirect) navigate(entry.redirect, { replace: true });
else if (pages[entry.page]) {
  const component = defineAsyncComponent({
    loader: pages[entry.page],
    errorComponent: { render: () => h('main', { class: 'paper-page app-shell' }, [h('p', '页面暂时无法加载，请刷新后重试。'), h('a', { href: entry.page.startsWith('prototype-') ? './index.html?prototype=1' : './index.html', class: 'paper-link' }, '返回首页')]) },
  });
  const app = createApp(component, ['biography', 'chapter', 'story'].includes(entry.page) ? { kind: entry.page } : {});
  app.mount('#app');
  if (import.meta.hot) import.meta.hot.dispose(() => app.unmount());
}
