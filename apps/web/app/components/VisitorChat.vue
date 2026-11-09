<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue';
import type { ConversationView, Message, Page } from '@smartdesk/shared';
import { useSupportClient } from '../composables/useSupportClient';
import { ClientError } from '../services/api';

const selected = ref<string | null>(null);
const support = useSupportClient(selected);
const conversations = ref<ConversationView[]>([]);
const detail = ref<ConversationView | null>(null);
const cursor = ref<string | null>(null);
const listLoading = ref(false);
const listError = ref('');
const error = ref('');
const notice = ref('');
const newDraft = ref('');
const first = ref<{
  clientConversationId: string;
  firstMessage: { clientMessageId: string; content: string };
} | null>(null);
const creating = ref(false);
const command = ref<{
  action: 'handoff' | 'close';
  id: string;
  body: Record<string, unknown>;
} | null>(null);
const commanding = ref(false);
const composing = ref(false);
const messageList = ref<HTMLElement>();
let active = true;
let selection = 0;
let detailPending = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const names = {
  ai_active: 'AI 接待',
  waiting_human: '等待人工',
  human_active: '人工接待',
  closed: '咨询已结束',
};
const state = computed(() => support.state.value);
// Message version watermarks do not establish the version of a status snapshot.
// Events trigger a detail read; only a confirmed conversation view drives actions.
const status = computed(() => detail.value?.status);
const closed = computed(() => status.value === 'closed');
const draft = computed({
  get: () =>
    selected.value ? (state.value?.draft.text ?? '') : newDraft.value,
  set: (text: string) =>
    selected.value ? support.client().setDraft(text) : (newDraft.value = text),
});
const locked = computed(
  () => creating.value || !!first.value || commanding.value || !!command.value,
);
const canSend = computed(
  () =>
    !closed.value &&
    !locked.value &&
    !!draft.value.trim() &&
    Array.from(draft.value).length <= 8000 &&
    (!selected.value || !!detail.value),
);
const errorText = (e: unknown) =>
  e instanceof Error ? e.message : '请求失败，请重试';
function merge(value: ConversationView) {
  const index = conversations.value.findIndex((c) => c.id === value.id);
  if (index < 0) conversations.value.unshift(value);
  else if (conversations.value[index]!.version <= value.version)
    conversations.value[index] = value;
}
async function refreshList(more = false, initial = false) {
  if (listLoading.value) return;
  listLoading.value = true;
  listError.value = '';
  const generation = selection;
  try {
    const page = await support
      .client()
      .request<Page<ConversationView>>(
        `/conversations?limit=50${more && cursor.value ? '&cursor=' + encodeURIComponent(cursor.value) : ''}`,
      );
    if (!active) return;
    if (more) for (const c of page.items) merge(c);
    else conversations.value = page.items;
    cursor.value = page.nextCursor;
    if (
      initial &&
      generation === selection &&
      !selected.value &&
      !first.value &&
      !newDraft.value &&
      page.items[0]
    )
      choose(page.items[0].id);
  } catch (e) {
    if (active) listError.value = errorText(e);
  } finally {
    if (active) listLoading.value = false;
  }
}
async function refreshDetail() {
  const id = selected.value,
    generation = selection;
  if (!id || detailPending) return;
  detailPending = true;
  try {
    const value = await support
      .client()
      .request<ConversationView>(`/conversations/${id}`);
    if (!active || generation !== selection) return;
    if (!detail.value || value.version >= detail.value.version)
      detail.value = value;
    merge(value);
  } catch (e) {
    if (active && generation === selection) error.value = errorText(e);
  } finally {
    detailPending = false;
  }
}
function choose(id: string | null) {
  if (locked.value) return;
  selection++;
  selected.value = id;
  detail.value = conversations.value.find((c) => c.id === id) ?? null;
  error.value = '';
  notice.value = '';
  void refreshDetail();
}
async function create() {
  if (!first.value || creating.value) return;
  creating.value = true;
  error.value = '';
  const pending = first.value;
  try {
    const result = await support
      .client()
      .request<{ conversation: ConversationView; message: Message }>(
        '/conversations',
        {
          method: 'POST',
          body: pending,
          commandId: pending.clientConversationId,
        },
      );
    if (!active || first.value !== pending) return;
    merge(result.conversation);
    if (newDraft.value === pending.firstMessage.content) newDraft.value = '';
    first.value = null;
    creating.value = false;
    choose(result.conversation.id);
    notice.value = '首条消息已保存';
  } catch (e) {
    if (active)
      error.value = `${errorText(e)}。首条消息尚未确认，请重试原请求。`;
  } finally {
    if (active) creating.value = false;
  }
}
function send() {
  if (composing.value || !canSend.value) return;
  error.value = '';
  if (selected.value) {
    try {
      support.client().send(draft.value);
    } catch (e) {
      error.value = errorText(e);
    }
  } else {
    first.value = {
      clientConversationId: crypto.randomUUID(),
      firstMessage: {
        clientMessageId: crypto.randomUUID(),
        content: newDraft.value,
      },
    };
    void create();
  }
}
function keydown(event: KeyboardEvent) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.isComposing ||
    composing.value ||
    event.keyCode === 229
  )
    return;
  event.preventDefault();
  send();
}
async function act(action: 'handoff' | 'close') {
  if (!selected.value || !detail.value || commanding.value) return;
  if (command.value && command.value.action !== action) return;
  command.value ??= {
    action,
    id: crypto.randomUUID(),
    body:
      action === 'handoff'
        ? { reason: 'customer_request' }
        : {
            expectedVersion: Math.max(
              detail.value.version,
              state.value?.conversationVersion ?? 0,
            ),
            resolution: 'unconfirmed',
          },
  };
  const pending = command.value,
    id = selected.value,
    generation = selection;
  commanding.value = true;
  error.value = '';
  notice.value = '';
  try {
    const result = await support
      .client()
      .request<ConversationView>(`/conversations/${id}/${action}`, {
        method: 'POST',
        body: pending.body,
        commandId: pending.id,
      });
    if (!active || generation !== selection) return;
    detail.value = result;
    merge(result);
    command.value = null;
    notice.value = action === 'handoff' ? '转人工请求已确认' : '咨询已结束';
    support.client().recoverNow();
  } catch (e) {
    if (!active || generation !== selection) return;
    error.value = `${action === 'handoff' ? '转人工' : '结束咨询'}尚未确认：${errorText(e)}`;
    if (e instanceof ClientError && e.status > 0 && e.status < 500)
      command.value = null;
    void refreshDetail();
  } finally {
    if (active && generation === selection) commanding.value = false;
  }
}
function poll() {
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') await refreshDetail();
    if (active) poll();
  }, 5000);
}
watch(
  () => state.value?.conversationVersion,
  () => {
    void refreshDetail();
  },
);
watch(
  () => state.value?.messages.length,
  async () => {
    const list = messageList.value;
    const nearBottom =
      list && list.scrollHeight - list.scrollTop - list.clientHeight < 120;
    if (nearBottom) {
      await nextTick();
      list.scrollTop = list.scrollHeight;
    }
  },
);
onMounted(() => {
  void refreshList(false, true);
  poll();
});
onBeforeUnmount(() => {
  active = false;
  selection++;
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <section class="visitor-chat" aria-label="访客咨询">
    <div class="history-tools">
      <label
        >我的咨询<select
          :value="selected ?? ''"
          :disabled="locked"
          @change="choose(($event.target as HTMLSelectElement).value || null)"
        >
          <option value="">新咨询</option>
          <option v-for="c in conversations" :key="c.id" :value="c.id">
            {{ names[c.status] }} ·
            {{ c.lastMessageSummary?.slice(0, 24) || '咨询记录' }}
          </option>
        </select></label
      >
      <button type="button" :disabled="listLoading" @click="refreshList()">
        刷新历史
      </button>
      <button
        v-if="cursor"
        type="button"
        :disabled="listLoading"
        @click="refreshList(true)"
      >
        更多咨询
      </button>
    </div>
    <p v-if="listLoading" role="status">正在读取咨询记录…</p>
    <p v-if="listError" class="error" role="alert">
      {{ listError }} <button @click="refreshList()">重试历史</button>
    </p>
    <header class="reception">
      <strong>{{
        status ? names[status as keyof typeof names] : '开始咨询'
      }}</strong>
      <span v-if="status === 'human_active'">
        · {{ detail?.assignedDisplayName || '人工客服' }}</span
      >
      <p v-if="!selected">
        当前提供人工接待，AI 自动回复尚未开放。请描述问题，无需填写邮箱。
      </p>
      <p v-else-if="status === 'waiting_human'">
        尚未接通客服。你可以继续留言，团队接待后会在这里回复，请稍后回来查看。
      </p>
      <p v-else-if="status === 'ai_active'">
        AI 接待状态；当前未开放自动回复，你可以主动转人工。
      </p>
      <p v-else-if="closed">
        {{
          detail?.resolution === 'customer_confirmed'
            ? '你已确认问题解决。'
            : '本次咨询已结束，历史记录保留。'
        }}
      </p>
      <p v-if="selected && state?.connection !== 'socket'" role="status">
        {{
          state?.connection === 'http'
            ? '实时连接暂不可用，正在通过网络补拉；未确认消息可重试。'
            : '正在连接消息服务…'
        }}
      </p>
    </header>
    <div
      ref="messageList"
      class="messages"
      aria-label="消息记录"
      aria-live="polite"
      aria-relevant="additions text"
    >
      <button
        v-if="state?.hasOlder"
        :disabled="state.historyLoading"
        @click="support.client().loadOlder()"
      >
        {{ state.historyLoading ? '正在读取…' : '更早消息' }}
      </button>
      <p v-if="state?.historyError" role="alert">{{ state.historyError }}</p>
      <p v-if="selected && state?.loading" role="status">正在读取消息…</p>
      <p v-if="!selected && !first" class="empty">
        说说你遇到的问题，我们从这里开始。
      </p>
      <article
        v-for="m in state?.messages ?? []"
        :key="m.id ?? m.clientMessageId"
        class="message"
        :class="{ own: m.senderType === 'visitor' }"
        :data-message-id="m.id"
        :data-status="m.status"
      >
        <small>{{
          m.senderType === 'visitor'
            ? '你'
            : m.senderType === 'ai'
              ? 'AI 客服'
              : m.senderType === 'system'
                ? '系统'
                : '人工客服'
        }}</small>
        <p>{{ m.content }}</p>
        <small>{{
          m.status === 'sent'
            ? '已保存'
            : m.status === 'failed'
              ? '发送失败'
              : '待确认，尚未确认保存'
        }}</small>
        <template v-if="m.status !== 'sent'">
          <p v-if="m.error" role="status">{{ m.error }}</p>
          <button @click="support.client().retry(m.clientMessageId)">
            重试此消息
          </button>
        </template>
      </article>
      <article v-if="first" class="message own" data-status="pending">
        <small>你</small>
        <p>{{ first.firstMessage.content }}</p>
        <small>待确认，尚未确认保存</small
        ><button :disabled="creating" @click="create">
          {{ creating ? '正在发送…' : '重试首条消息' }}
        </button>
      </article>
    </div>
    <p v-if="state?.error && selected" role="alert" class="error">
      {{ state.error }}
      <button @click="support.client().recoverNow()">重试连接</button>
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <form v-if="!closed" class="composer" @submit.prevent="send">
      <label for="visitor-message"
        >消息<textarea
          id="visitor-message"
          v-model="draft"
          rows="3"
          :disabled="!!first"
          placeholder="输入问题或补充说明…"
          @compositionstart="composing = true"
          @compositionend="composing = false"
          @keydown="keydown"
        />
      </label>
      <small>Enter 发送 · Shift+Enter 换行 · 最多 8,000 字符</small>
      <button type="submit" class="primary" :disabled="!canSend">
        发送消息
      </button>
    </form>
    <div class="actions">
      <button
        v-if="selected && !closed"
        :disabled="commanding || (!!command && command.action !== 'handoff')"
        @click="act('handoff')"
      >
        {{
          commanding && command?.action === 'handoff'
            ? '正在请求人工…'
            : command?.action === 'handoff'
              ? '重试转人工请求'
              : '转人工'
        }}
      </button>
      <button
        v-if="selected && !closed"
        :disabled="commanding || (!!command && command.action !== 'close')"
        @click="act('close')"
      >
        {{
          commanding && command?.action === 'close'
            ? '正在结束…'
            : command?.action === 'close'
              ? '重试结束请求'
              : '结束咨询'
        }}
      </button>
      <button
        v-if="closed"
        :disabled="locked"
        class="primary"
        @click="choose(null)"
      >
        发起新咨询
      </button>
      <button
        v-if="closed && command"
        :disabled="commanding"
        @click="act(command.action)"
      >
        确认上次操作结果
      </button>
    </div>
  </section>
</template>

<style scoped>
.visitor-chat {
  min-width: 0;
}
.history-tools,
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
}
.history-tools label {
  flex: 1;
  min-width: 140px;
}
select,
textarea {
  width: 100%;
  box-sizing: border-box;
  font: inherit;
  color: inherit;
  background: #fff;
  border: 1px solid #b8c7bf;
  border-radius: 6px;
  padding: 9px;
}
button {
  cursor: pointer;
  font: inherit;
  border: 1px solid #b8c7bf;
  border-radius: 6px;
  background: #fff;
  color: #19332e;
  padding: 8px 10px;
}
button:disabled {
  opacity: 0.5;
  cursor: default;
}
button:focus-visible,
textarea:focus-visible,
select:focus-visible {
  outline: 3px solid #b88c32;
  outline-offset: 2px;
}
.primary {
  background: #183f35;
  color: #fff;
}
.reception {
  margin: 14px 0 8px;
  padding: 12px;
  background: #edf2ed;
  border-radius: 8px;
}
.reception p,
small {
  font-size: 12px;
  line-height: 1.6;
}
.reception p {
  margin: 6px 0 0;
}
.messages {
  max-height: 330px;
  min-height: 100px;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px;
}
.message {
  background: #eef1eb;
  border-radius: 10px;
  padding: 10px 12px;
  margin: 10px 24px 10px 0;
  overflow-wrap: anywhere;
}
.message.own {
  background: #e4eee7;
  margin: 10px 0 10px 24px;
}
.message p {
  white-space: pre-wrap;
  margin: 5px 0;
}
.message small {
  color: #526b5f;
}
.message button {
  display: block;
  margin-top: 8px;
}
.empty {
  color: #65756d;
  padding: 12px 0;
  font-size: 14px;
}
.composer {
  display: grid;
  gap: 8px;
  margin: 14px 0;
}
.composer button {
  justify-self: end;
}
.actions {
  margin: 12px 0;
}
.error {
  overflow-wrap: anywhere;
}
@media (max-width: 360px) {
  .history-tools label {
    flex-basis: 100%;
  }
  .message {
    margin-right: 10px;
  }
  .message.own {
    margin-left: 10px;
  }
}
</style>
