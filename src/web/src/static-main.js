import { createApp, defineAsyncComponent, h } from 'vue';
import { staticEntryFor } from './lib/static-entries.js';
import { navigate } from './lib/navigation.js';
import './styles/base.css';

const pages = {
  'prototype-home': () => import('./pages/PrototypeHomePage.vue'),
  'prototype-interview': () => import('./pages/PrototypeInterviewPage.vue'),
  'prototype-story': () => import('./pages/PrototypeStoryPage.vue'),
  'prototype-biography': () => import('./pages/PrototypeBiographyPage.vue'),
  'prototype-chapter': () => import('./pages/PrototypeChapterPage.vue'),
  'prototype-profile': () => import('./pages/PrototypeProfilePage.vue'),
  'prototype-history': () => import('./pages/PrototypeHistoryPage.vue'),
  'prototype-organizing': () => import('./pages/PrototypeOrganizingPage.vue'),
  'prototype-family': () => import('./pages/PrototypeFamilyPage.vue'),
  login: () => import('./pages/LoginPage.vue'),
};
const entry = staticEntryFor(location.pathname, location.search);
if (entry.redirect) navigate(entry.redirect, { replace: true });
else {
  const component = defineAsyncComponent({
    loader: pages[entry.page],
    errorComponent: { render: () => h('main', { class: 'paper-page app-shell' }, [
      h('p', '页面暂时无法加载，请刷新后重试。'),
      h('a', { href: './index.html', class: 'paper-link' }, '返回首页'),
    ]) },
  });
  const app = createApp(component);
  app.mount('#app');
  if (import.meta.hot) import.meta.hot.dispose(() => app.unmount());
}
