import { useNuxtApp } from '#app';
import { onMounted, onBeforeUnmount, shallowRef, watch, type Ref } from 'vue';
import type { SupportSnapshot } from '../services/support-client';

/** Components share the app client; releasing the last conversation consumer releases its subscription. */
export function useSupportClient(conversationId?: Ref<string | null>) {
  const app = useNuxtApp();
  const state = shallowRef<SupportSnapshot | null>(null);
  let release: (() => void) | undefined;
  let unlisten: (() => void) | undefined;
  let unwatch: (() => void) | undefined;
  onMounted(() => {
    unlisten = app.$support.listen((value) => {
      state.value = value;
    });
    if (conversationId)
      unwatch = watch(
        conversationId,
        (id) => {
          release?.();
          release = id ? app.$support.openConversation(id) : undefined;
        },
        { immediate: true },
      );
  });
  onBeforeUnmount(() => {
    unwatch?.();
    release?.();
    unlisten?.();
  });
  return { state, client: () => app.$support };
}
