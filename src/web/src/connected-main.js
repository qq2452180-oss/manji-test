import { createApp, defineAsyncComponent, h } from 'vue';
import { navigate } from './lib/navigation.js';
import ConnectedAccessGate from './components/ConnectedAccessGate.vue';
import './styles/base.css';
import './styles/connected.css';

const page = location.pathname.split('/').pop() || 'index.html';
const pages = {
  'index.html': () => import('./pages/ConnectedHomePage.vue'),
  'interview.html': () => import('./pages/ConnectedInterviewPage.vue'),
  'organizing.html': () => import('./pages/ConnectedOrganizingPage.vue'),
  'story.html': () => import('./pages/ConnectedStoryPage.vue'),
  'biography.html': () => import('./pages/ConnectedLibraryPage.vue'),
  'chapter.html': () => import('./pages/ConnectedLibraryPage.vue'),
  'history.html': () => import('./pages/ConnectedHistoryPage.vue'),
  'profile.html': () => import('./pages/ConnectedUtilityPage.vue'),
  'login.html': () => import('./pages/ConnectedLoginPage.vue'),
  'preview.html': () => import('./pages/ConnectedUtilityPage.vue'),
};
const aliases = {
  'text-chat.html': 'interview.html', 'realtime-interview.html': 'interview.html',
  'photo.html': 'interview.html', 'interview-history.html': 'history.html',
  'welcome.html': 'index.html', 'profile-edit.html': 'profile.html',
};
if (aliases[page]) navigate('./' + aliases[page] + location.search, { replace: true });
else if (!pages[page]) navigate('./index.html', { replace: true });
else {
  const component = defineAsyncComponent({
    loader: pages[page],
    errorComponent: { render: () => h('main', { class: 'paper-page app-shell' }, [
      h('p', '页面暂时无法加载，请刷新后重试。'), h('a', { href: './index.html' }, '返回人生轨迹'),
    ]) },
  });
  const app = createApp(page === 'login.html' ? component : {
    render: () => h(ConnectedAccessGate, null, { default: () => h(component) }),
  });
  app.mount('#app');
  if (import.meta.hot) import.meta.hot.dispose(() => app.unmount());
}
