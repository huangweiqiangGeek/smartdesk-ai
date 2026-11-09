<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from '#app';
import type { VisitorCustomerView } from '@smartdesk/shared';
import { useSupportClient } from '../../composables/useSupportClient';
const support = useSupportClient();
const route = useRoute();
const publicKey = String(route.params.publicKey);
const parentOrigin = String(route.query.parentOrigin ?? '');
const channel = String(route.query.channel ?? '');
const customer = ref<VisitorCustomerView>();
const name = ref('');
const email = ref('');
const language = ref('zh');
const welcome = ref('欢迎咨询');
const warning = ref('');
const message = ref('');
const busy = ref(false);
let token = '';
let pending: { key: string; body: string } | undefined;
let active = true;
let identityGeneration = 0;
let waiting: ReturnType<typeof setInterval> | undefined;
watch(
  () => support.state.value?.connection,
  (connection) => {
    if (connection !== 'expired') return;
    identityGeneration++;
    token = '';
    customer.value = undefined;
    name.value = '';
    email.value = '';
    pending = undefined;
    busy.value = false;
    message.value = '访客身份已失效，请刷新页面重新连接。';
  },
  { flush: 'sync' },
);
function send(type: string) {
  if (parentOrigin)
    window.parent.postMessage({ type, publicKey, channel }, parentOrigin);
}
function receive(event: MessageEvent) {
  if (event.origin !== parentOrigin || event.source !== window.parent) return;
  const data = event.data;
  if (
    !data ||
    data.type !== 'smartdesk:init' ||
    data.publicKey !== publicKey ||
    data.channel !== channel
  )
    return;
  const payload = data.payload;
  if (
    !payload?.customer ||
    !/^[a-f0-9]{64}$/.test(payload.visitorToken ?? '') ||
    payload.widget?.publicKey !== publicKey
  )
    return;
  if (waiting) clearInterval(waiting);
  if (token !== payload.visitorToken) {
    identityGeneration++;
    busy.value = false;
  }
  token = payload.visitorToken;
  support.client().setIdentity({
    kind: 'visitor',
    customerId: payload.customer.id,
    publicKey,
    token,
  });
  customer.value = payload.customer;
  name.value = payload.customer.name ?? '';
  email.value = payload.customer.email ?? '';
  language.value = payload.customer.preferredLanguage;
  welcome.value = payload.widget.welcomeText || '欢迎咨询';
  warning.value = !data.storageAvailable
    ? '浏览器无法保存访客凭据。本页仍可使用，刷新或关闭后可能无法恢复。'
    : payload.identityReset
      ? '原访客凭据已过期，已建立新的咨询身份。'
      : '';
  pending = undefined;
  message.value = '';
}
async function save() {
  if (!customer.value || busy.value) return;
  busy.value = true;
  const generation = identityGeneration;
  message.value = '';
  const body = JSON.stringify({
    expectedVersion: customer.value.version,
    name: name.value,
    email: email.value,
    preferredLanguage: language.value,
  });
  if (!pending || pending.body !== body)
    pending = { key: crypto.randomUUID(), body };
  try {
    const result = await support
      .client()
      .request<VisitorCustomerView>(`/customers/${customer.value.id}`, {
        method: 'PATCH',
        body: JSON.parse(body),
        commandId: pending.key,
      });
    if (!active || generation !== identityGeneration) return;
    customer.value = result;
    pending = undefined;
    message.value = '资料已保存';
  } catch (error) {
    if (active && generation === identityGeneration)
      message.value =
        error instanceof Error ? error.message : '保存失败，请重试';
  } finally {
    if (active && generation === identityGeneration) busy.value = false;
  }
}
onMounted(() => {
  try {
    if (
      new URL(parentOrigin).origin !== parentOrigin ||
      !/^https?:/.test(parentOrigin) ||
      !channel
    )
      return;
  } catch {
    return;
  }
  window.addEventListener('message', receive);
  send('smartdesk:ready');
  waiting = setInterval(() => send('smartdesk:ready'), 1000);
});
onBeforeUnmount(() => {
  active = false;
  identityGeneration++;
  support.client().setIdentity(null);
  token = '';
  window.removeEventListener('message', receive);
  if (waiting) clearInterval(waiting);
});
</script>

<template>
  <main class="widget-panel">
    <header>
      <span class="widget-label">访客服务</span>
      <h1>{{ welcome }}</h1>
    </header>
    <p v-if="!customer" role="status">{{ message || '正在建立访客连接…' }}</p>
    <template v-else>
      <p class="connected" role="status">访客身份已连接</p>
      <p v-if="warning" class="error" role="status">{{ warning }}</p>
      <p class="hint">
        联系资料选填，方便后续跟进。目前可管理访客资料，消息咨询即将开放。
      </p>
      <form @submit.prevent="save">
        <label
          >姓名（选填）<input
            v-model="name"
            name="name"
            maxlength="100"
            autocomplete="name"
            :disabled="busy"
        /></label>
        <label
          >邮箱（选填）<input
            v-model="email"
            name="email"
            type="email"
            maxlength="254"
            autocomplete="email"
            :disabled="busy"
        /></label>
        <label
          >偏好语言<select v-model="language" name="language" :disabled="busy">
            <option value="zh">中文</option>
            <option value="en">English</option>
          </select></label
        >
        <button type="submit" class="primary" :disabled="busy">
          {{ busy ? '正在保存…' : '保存资料' }}
        </button>
      </form>
      <p v-if="message" role="status">{{ message }}</p>
      <button
        class="text-button"
        :disabled="busy"
        @click="send('smartdesk:refresh')"
      >
        刷新资料
      </button>
    </template>
  </main>
</template>

<style scoped>
.widget-panel {
  padding: 20px;
}
.widget-label {
  color: #6d7c75;
  font-size: 12px;
  letter-spacing: 2px;
}
h1 {
  font-size: 21px;
  line-height: 1.5;
  margin: 8px 0;
  overflow-wrap: anywhere;
}
.connected {
  color: #245b49;
  font-size: 14px;
}
form {
  margin: 20px 0 12px;
  gap: 12px;
}
input,
select {
  padding: 8px 10px;
}
select {
  background: white;
  color: #19332e;
  border: 1px solid #c7d0c9;
  border-radius: 5px;
  font: inherit;
}
.error {
  margin: 12px 0;
  font-size: 13px;
}
</style>
