<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import type { SupportSnapshot } from '../services/support-client';
const props = defineProps<{
  state: SupportSnapshot | null;
  canSend: boolean;
}>();
const emit = defineEmits<{ older: []; retry: [id: string]; recover: [] }>();
const scroll = ref<globalThis.HTMLElement>();
const atBottom = ref(true);
let previousHeight = 0;
function older() {
  previousHeight = scroll.value?.scrollHeight ?? 0;
  emit('older');
}
watch(
  () => props.state?.messages.length,
  async () => {
    await nextTick();
    if (!scroll.value) return;
    if (previousHeight) {
      scroll.value.scrollTop += scroll.value.scrollHeight - previousHeight;
      previousHeight = 0;
    } else if (atBottom.value)
      scroll.value.scrollTop = scroll.value.scrollHeight;
  },
);
const label = { visitor: '访客', agent: '客服', ai: 'AI', system: '系统' };
</script>
<template>
  <section
    ref="scroll"
    class="inbox-timeline"
    aria-label="公开消息记录"
    @scroll="
      atBottom =
        !!scroll &&
        scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 80
    "
  >
    <p class="inbox-caption" role="status">
      {{
        state?.connection === 'socket'
          ? '实时连接已建立'
          : state?.connection === 'http'
            ? '正在使用 HTTP 恢复消息'
            : '正在连接…'
      }}
    </p>
    <button
      v-if="state?.hasOlder"
      :disabled="state.historyLoading"
      @click="older"
    >
      {{ state.historyLoading ? '正在加载…' : '加载更早消息' }}
    </button>
    <p v-if="state?.historyError" role="alert">
      {{ state.historyError }} <button @click="older">重试历史</button>
    </p>
    <p v-if="state?.loading" role="status">正在加载消息…</p>
    <p v-if="state?.error" role="alert">
      {{ state.error }} <button @click="emit('recover')">重试消息</button>
    </p>
    <p
      v-if="state && !state.loading && !state.error && !state.messages.length"
      class="inbox-empty"
    >
      暂无公开消息
    </p>
    <article
      v-for="item in state?.messages ?? []"
      :key="item.id ?? item.clientMessageId"
      class="inbox-message"
      :data-sender="item.senderType"
      :data-status="item.status"
    >
      <header>
        {{ label[item.senderType] }}
        <small v-if="item.status === 'sent'"
          >#{{ item.seq }} ·
          {{
            new Date(item.createdAt).toLocaleTimeString('zh-CN', {
              hour: '2-digit',
              minute: '2-digit',
            })
          }}</small
        ><small v-else>{{
          item.status === 'pending' ? '正在确认发送结果…' : '发送失败'
        }}</small>
      </header>
      <p>{{ item.content }}</p>
      <p
        v-if="item.status !== 'sent' && item.error"
        class="inbox-message-error"
      >
        {{ item.error }}
      </p>
      <button
        v-if="item.status !== 'sent'"
        :disabled="!canSend"
        @click="emit('retry', item.clientMessageId)"
      >
        查询并重试原消息
      </button>
    </article>
  </section>
</template>
