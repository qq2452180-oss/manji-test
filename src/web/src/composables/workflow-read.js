import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { getAuthToken } from '../lib/api.js';

// 读取已有记录不会创建新身份；账号变化或离开页面后丢弃迟到的响应。
export function useWorkflowRead(read, empty = () => null) {
  const data = shallowRef(empty()), loading = ref(true), error = ref(''), anonymous = ref(!getAuthToken()), authRequired = ref(false);
  let alive = true, version = 0;
  async function refresh() {
    const epoch = ++version;
    data.value = empty(); error.value = ''; authRequired.value = false; anonymous.value = !getAuthToken();
    if (anonymous.value) { loading.value = false; return; }
    loading.value = true;
    try {
      const result = await read();
      if (alive && epoch === version) data.value = result;
    } catch (cause) {
      if (alive && epoch === version) {
        error.value = cause.message || '暂时无法读取，请重试。';
        authRequired.value = cause.status === 401;
      }
    }
    finally { if (alive && epoch === version) loading.value = false; }
  }
  onMounted(() => { void refresh(); window.addEventListener('pageshow', refresh); window.addEventListener('manji:auth-changed', refresh); });
  onBeforeUnmount(() => { alive = false; ++version; window.removeEventListener('pageshow', refresh); window.removeEventListener('manji:auth-changed', refresh); });
  return { data, loading, error, anonymous, authRequired, refresh };
}
